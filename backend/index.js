const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = 3001;
const VALID_PHOTO_STATUSES = ['pending', 'approved', 'rejected', 'flagged', 'exported'];

// SSL Options
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/mobile', express.static(path.join(__dirname, '../frontend-mobile')));
app.use('/dashboard', express.static(path.join(__dirname, '../frontend-dashboard')));

// Root Redirect
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; padding: 50px; text-align: center;">
            <h1 style="color: #e11d48;">TMN POP SYSTEM PROTOTYPE</h1>
            <p style="color: #64748b;">(Secure HTTPS Mode)</p>
            <p>Select a portal to enter:</p>
            <div style="margin-top: 30px;">
                <a href="/dashboard" style="display: inline-block; padding: 15px 30px; background: #0f172a; color: white; text-decoration: none; border-radius: 8px; margin: 10px;">📊 Admin Dashboard</a>
                <a href="/mobile" style="display: inline-block; padding: 15px 30px; background: #e11d48; color: white; text-decoration: none; border-radius: 8px; margin: 10px;">📱 Mobile App (Ops App)</a>
            </div>
        </div>
    `);
});

// Storage Setup
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'uploads';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Database Setup
const db = new sqlite3.Database('./tmn_pop.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the TMN POP database.');
});

const ensureColumn = (table, column, definition) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
        if (err) return console.error(err.message);
        const exists = rows.some(row => row.name === column);
        if (!exists) {
            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
                if (alterErr) console.error(alterErr.message);
            });
        }
    });
};

const getCycleSettings = (cb) => {
    db.all("SELECT key, value FROM app_settings WHERE key IN ('cycle_start', 'cycle_end', 'cycle_name')", [], (err, rows) => {
        if (err) return cb(err);
        const settings = rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
        cb(null, {
            name: settings.cycle_name || 'Weekly PoP Cycle',
            start: settings.cycle_start || '2026-04-13',
            end: settings.cycle_end || '2026-04-19'
        });
    });
};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS buildings (
        id TEXT PRIMARY KEY,
        name TEXT,
        lat REAL,
        lng REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS screens (
        id TEXT PRIMARY KEY,
        building_id TEXT,
        qr_code TEXT UNIQUE,
        FOREIGN KEY(building_id) REFERENCES buildings(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS operators (
        id TEXT PRIMARY KEY,
        name TEXT,
        grid_zone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        screen_id TEXT,
        operator_id TEXT,
        advertiser_id INTEGER,
        url TEXT,
        timestamp TEXT,
        lat REAL,
        lng REAL,
        status TEXT DEFAULT 'pending',
        review_note TEXT,
        reviewed_at TEXT,
        exported_at TEXT,
        FOREIGN KEY(screen_id) REFERENCES screens(id),
        FOREIGN KEY(operator_id) REFERENCES operators(id),
        FOREIGN KEY(advertiser_id) REFERENCES advertisers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS advertisers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS export_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photo_count INTEGER,
        success_count INTEGER,
        created_at TEXT,
        note TEXT
    )`);

    ensureColumn('photos', 'review_note', 'TEXT');
    ensureColumn('photos', 'reviewed_at', 'TEXT');
    ensureColumn('photos', 'exported_at', 'TEXT');

    // Seed some initial data
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B001', 'Wisma Thamrin', -6.189, 106.823)");
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B002', 'Sudirman Tower', -6.215, 106.816)");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S001', 'B001', 'QR_S001')");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S002', 'B001', 'QR_S002')");
    db.run("INSERT OR IGNORE INTO operators VALUES ('OP01', 'Budi', 'Central')");
    db.run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cycle_name', 'Weekly PoP Cycle')");
    db.run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cycle_start', '2026-04-13')");
    db.run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cycle_end', '2026-04-19')");
    
    // Seed Advertisers
    db.all("SELECT COUNT(*) as count FROM advertisers", [], (err, rows) => {
        if (rows && rows[0].count === 0) {
            const clients = ['Coca Cola', 'Samsung', 'Toyota', 'Indofood', 'Shopee', 'Gojek'];
            clients.forEach(name => {
                db.run("INSERT INTO advertisers (name) VALUES (?)", [name]);
            });
        }
    });
});

// API Endpoints

// Shared cycle settings for dashboard and mobile history filters
app.get('/api/settings/cycle', (req, res) => {
    getCycleSettings((err, settings) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(settings);
    });
});

app.post('/api/settings/cycle', (req, res) => {
    const { name, start, end } = req.body;
    if (!start || !end) return res.status(400).json({ error: 'Cycle start and end are required' });

    const updates = [
        ['cycle_name', name || 'Weekly PoP Cycle'],
        ['cycle_start', start],
        ['cycle_end', end]
    ];

    const stmt = db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    updates.forEach(([key, value]) => stmt.run(key, value));
    stmt.finalize((err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, name: name || 'Weekly PoP Cycle', start, end });
    });
});

// Get all advertisers
app.get('/api/advertisers', (req, res) => {
    db.all("SELECT * FROM advertisers ORDER BY name ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Update photo advertiser
app.post('/api/photos/update-advertiser', (req, res) => {
    const { photo_id, advertiser_id } = req.body;
    const value = advertiser_id ? advertiser_id : null;
    db.run("UPDATE photos SET advertiser_id = ? WHERE id = ?", [value, photo_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Update photo review status
app.post('/api/photos/update-status', (req, res) => {
    const { photo_id, status, review_note } = req.body;
    if (!VALID_PHOTO_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid photo status' });
    }

    db.run(
        "UPDATE photos SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?",
        [status, review_note || null, new Date().toISOString(), photo_id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Get screen by QR
app.get('/api/screens/:qr', (req, res) => {
    const query = `
        SELECT screens.*, buildings.name as building_name 
        FROM screens 
        JOIN buildings ON screens.building_id = buildings.id 
        WHERE qr_code = ?`;
    db.get(query, [req.params.qr], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Screen not found' });
        res.json(row);
    });
});

// Upload photo
app.post('/api/upload', upload.single('photo'), (req, res) => {
    const { screen_id, operator_id, lat, lng, timestamp } = req.body;
    const url = `/uploads/${req.file.filename}`;
    
    const query = `INSERT INTO photos (screen_id, operator_id, url, timestamp, lat, lng) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [screen_id, operator_id, url, timestamp, lat, lng], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, url });
    });
});

// Dashboard stats
app.get('/api/dashboard/stats', (req, res) => {
    const { cycle_start, cycle_end } = req.query;
    const cycleFilter = cycle_start && cycle_end ? `datetime(timestamp) BETWEEN datetime(?) AND datetime(?)` : '';
    const cycleParams = cycle_start && cycle_end ? [`${cycle_start}T00:00:00`, `${cycle_end}T23:59:59`] : [];
    const whereFor = (extra) => {
        const parts = [cycleFilter, extra].filter(Boolean);
        return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    };
    const query = `SELECT
        (SELECT COUNT(*) FROM screens) as total_screens,
        (SELECT COUNT(*) FROM photos ${whereFor('')}) as completed_photos,
        (SELECT COUNT(*) FROM photos ${whereFor("status = 'pending'")}) as pending_photos,
        (SELECT COUNT(*) FROM photos ${whereFor("status = 'approved'")}) as approved_photos,
        (SELECT COUNT(*) FROM photos ${whereFor("status = 'rejected'")}) as rejected_photos,
        (SELECT COUNT(*) FROM photos ${whereFor("status = 'flagged'")}) as flagged_photos,
        (SELECT COUNT(*) FROM photos ${whereFor("status = 'exported'")}) as exported_photos,
        (SELECT COUNT(DISTINCT operator_id) FROM photos ${whereFor('')}) as active_operators`;
    const allParams = [...cycleParams, ...cycleParams, ...cycleParams, ...cycleParams, ...cycleParams, ...cycleParams, ...cycleParams];
    db.get(query, allParams, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            total_screens: row.total_screens || 0,
            completed_photos: row.completed_photos || 0,
            pending_photos: row.pending_photos || 0,
            approved_photos: row.approved_photos || 0,
            rejected_photos: row.rejected_photos || 0,
            flagged_photos: row.flagged_photos || 0,
            exported_photos: row.exported_photos || 0,
            active_operators: row.active_operators || 0
        });
    });
});

// Get all photos
app.get('/api/dashboard/photos', (req, res) => {
    const { advertiser_id, status, cycle_start, cycle_end } = req.query;
    const filters = [];
    const params = [];
    if (advertiser_id) {
        filters.push('photos.advertiser_id = ?');
        params.push(advertiser_id);
    }
    if (status) {
        filters.push('photos.status = ?');
        params.push(status);
    }
    if (cycle_start && cycle_end) {
        filters.push('datetime(photos.timestamp) BETWEEN datetime(?) AND datetime(?)');
        params.push(`${cycle_start}T00:00:00`, `${cycle_end}T23:59:59`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const query = `
        SELECT photos.*, screens.qr_code, buildings.name as building_name, operators.name as operator_name, advertisers.name as advertiser_name
        FROM photos
        JOIN screens ON photos.screen_id = screens.id
        JOIN buildings ON screens.building_id = buildings.id
        JOIN operators ON photos.operator_id = operators.id
        LEFT JOIN advertisers ON photos.advertiser_id = advertisers.id
        ${where}
        ORDER BY photos.timestamp DESC`;
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Export / Sync photos to specific folder with custom naming
app.post('/api/photos/export', (req, res) => {
    const { photo_ids } = req.body;
    if (!photo_ids || !Array.isArray(photo_ids)) return res.status(400).json({ error: 'No photos selected' });

    const exportDir = path.join(__dirname, 'exported');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir);

    const query = `
        SELECT photos.*, advertisers.name as adv_name, buildings.name as bld_name
        FROM photos
        JOIN screens ON photos.screen_id = screens.id
        JOIN buildings ON screens.building_id = buildings.id
        LEFT JOIN advertisers ON photos.advertiser_id = advertisers.id
        WHERE photos.id IN (${photo_ids.map(() => '?').join(',')})`;

    db.all(query, photo_ids, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        console.log(`Exporting ${rows.length} photos...`);
        let successCount = 0;
        rows.forEach(row => {
            const sanitize = (s) => (s || 'Unknown').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-');
            const adv = sanitize(row.adv_name || 'Unassigned');
            const bld = sanitize(row.bld_name || 'Unknown');

            let timeStr = 'Time-Unknown';
            try {
                const d = new Date(row.timestamp);
                if (!isNaN(d.getTime())) {
                    timeStr = d.toISOString().replace(/T/, '_').replace(/:/g, '').split('.')[0];
                }
            } catch (e) {}

            const newFileName = `${adv}_${bld}_${timeStr}_ID${row.id}.jpg`;
            const relativeUrl = row.url.replace(/^\//, '');
            const sourcePath = path.join(__dirname, relativeUrl);
            const destPath = path.join(exportDir, newFileName);

            console.log(`[SYNC] Original: ${row.url} -> New: ${newFileName}`);

            if (fs.existsSync(sourcePath)) {
                fs.copyFileSync(sourcePath, destPath);
                successCount++;
            } else {
                console.warn(`[MISSING] No source file for ID ${row.id} at ${sourcePath}`);
            }
        });

        const exportedAt = new Date().toISOString();
        db.run(
            `INSERT INTO export_batches (photo_count, success_count, created_at, note) VALUES (?, ?, ?, ?)`,
            [photo_ids.length, successCount, exportedAt, `Manual export from dashboard/mobile`]
        );
        db.run(
            `UPDATE photos SET status = 'exported', exported_at = ? WHERE id IN (${photo_ids.map(() => '?').join(',')})`,
            [exportedAt, ...photo_ids]
        );

        res.json({
            success: true,
            count: successCount,
            message: `Successfully synced ${successCount} photos to exported folder.`
        });
    });
});

app.get('/api/dashboard/exports', (req, res) => {
    db.all("SELECT * FROM export_batches ORDER BY created_at DESC LIMIT 10", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

https.createServer(options, app).listen(PORT, () => {
    console.log(`Backend running at https://localhost:${PORT}`);
    console.log(`NOTE: If accessing from mobile, use your computer's IP address (e.g., https://192.168.1.5:3001)`);
});
