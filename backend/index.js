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
const VALID_TASK_STATUSES = ['not_started', 'captured', 'under_review', 'approved', 'rejected', 'exported'];

// SSL Options
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/exported', express.static(path.join(__dirname, 'exported')));
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

const sanitizeFilePart = (s) => (s || 'Unknown').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-');

const csvEscape = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    return `"${str.replace(/"/g, '""')}"`;
};

const updateCampaignScreenStatus = (screenId, status, cb = () => {}) => {
    const mappedStatus = status === 'pending' ? 'under_review' : status;
    db.run(
        `UPDATE campaign_screens
         SET status = ?, updated_at = ?
         WHERE screen_id = ?
           AND campaign_id = (SELECT id FROM campaigns WHERE status = 'active' ORDER BY id DESC LIMIT 1)`,
        [VALID_TASK_STATUSES.includes(mappedStatus) ? mappedStatus : 'under_review', new Date().toISOString(), screenId],
        cb
    );
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
        note TEXT,
        manifest_path TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        advertiser_id INTEGER,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TEXT,
        FOREIGN KEY(advertiser_id) REFERENCES advertisers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS campaign_screens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        screen_id TEXT,
        status TEXT DEFAULT 'not_started',
        expected_count INTEGER DEFAULT 1,
        updated_at TEXT,
        UNIQUE(campaign_id, screen_id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY(screen_id) REFERENCES screens(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        screen_id TEXT,
        operator_id TEXT,
        due_at TEXT,
        route_order INTEGER DEFAULT 0,
        status TEXT DEFAULT 'assigned',
        created_at TEXT,
        UNIQUE(campaign_id, screen_id, operator_id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY(screen_id) REFERENCES screens(id),
        FOREIGN KEY(operator_id) REFERENCES operators(id)
    )`);

    ensureColumn('photos', 'review_note', 'TEXT');
    ensureColumn('photos', 'reviewed_at', 'TEXT');
    ensureColumn('photos', 'exported_at', 'TEXT');
    ensureColumn('export_batches', 'manifest_path', 'TEXT');

    // Seed some initial data
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B001', 'Wisma Thamrin', -6.189, 106.823)");
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B002', 'Sudirman Tower', -6.215, 106.816)");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S001', 'B001', 'QR_S001')");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S002', 'B001', 'QR_S002')");
    db.run("INSERT OR IGNORE INTO operators VALUES ('OP01', 'Budi', 'Central')");
    db.run("INSERT OR IGNORE INTO operators VALUES ('OP02', 'Sari', 'South')");
    db.run("INSERT OR IGNORE INTO operators VALUES ('OP03', 'Andi', 'North')");
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

    db.get("SELECT COUNT(*) as count FROM campaigns", [], (err, row) => {
        if (!err && row && row.count === 0) {
            db.run(
                "INSERT INTO campaigns (name, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?)",
                ['Weekly PoP Cycle', '2026-04-13', '2026-04-19', 'active', new Date().toISOString()],
                function(insertErr) {
                    if (insertErr) return console.error(insertErr.message);
                    const campaignId = this.lastID;
                    db.all("SELECT id FROM screens", [], (screenErr, screens) => {
                        if (screenErr) return console.error(screenErr.message);
                        screens.forEach(screen => {
                            db.run(
                                "INSERT OR IGNORE INTO campaign_screens (campaign_id, screen_id, status, updated_at) VALUES (?, ?, ?, ?)",
                                [campaignId, screen.id, 'not_started', new Date().toISOString()]
                            );
                        });
                    });
                }
            );
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

app.get('/api/operators', (req, res) => {
    db.all("SELECT * FROM operators ORDER BY name ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/sites', (req, res) => {
    const query = `
        SELECT screens.*, buildings.name as building_name, buildings.lat, buildings.lng
        FROM screens
        JOIN buildings ON screens.building_id = buildings.id
        ORDER BY buildings.name ASC, screens.id ASC`;
    db.all(query, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/sites/import', (req, res) => {
    const { sites } = req.body;
    if (!Array.isArray(sites) || sites.length === 0) {
        return res.status(400).json({ error: 'sites array is required' });
    }

    let imported = 0;
    let completed = 0;
    const finish = () => {
        completed++;
        if (completed === sites.length) res.json({ success: true, imported });
    };

    db.serialize(() => {
        sites.forEach((site, idx) => {
            const buildingId = site.building_id || `B${String(Date.now()).slice(-5)}${idx}`;
            const screenId = site.screen_id || `S${String(Date.now()).slice(-5)}${idx}`;
            const qrCode = site.qr_code || `QR_${screenId}`;
            db.run(
                "INSERT OR IGNORE INTO buildings (id, name, lat, lng) VALUES (?, ?, ?, ?)",
                [buildingId, site.building_name || site.name || buildingId, Number(site.lat || 0), Number(site.lng || 0)]
            );
            db.run(
                "INSERT OR IGNORE INTO screens (id, building_id, qr_code) VALUES (?, ?, ?)",
                [screenId, buildingId, qrCode],
                function(err) {
                    if (!err && this.changes > 0) imported++;
                    finish();
                }
            );
        });
    });
});

app.get('/api/campaigns', (req, res) => {
    const query = `
        SELECT campaigns.*, advertisers.name as advertiser_name,
            COUNT(campaign_screens.id) as total_tasks,
            SUM(CASE WHEN campaign_screens.status = 'approved' THEN 1 ELSE 0 END) as approved_tasks,
            SUM(CASE WHEN campaign_screens.status = 'rejected' THEN 1 ELSE 0 END) as rejected_tasks,
            SUM(CASE WHEN campaign_screens.status IN ('captured', 'under_review') THEN 1 ELSE 0 END) as review_tasks,
            SUM(CASE WHEN campaign_screens.status = 'not_started' THEN 1 ELSE 0 END) as open_tasks
        FROM campaigns
        LEFT JOIN advertisers ON campaigns.advertiser_id = advertisers.id
        LEFT JOIN campaign_screens ON campaigns.id = campaign_screens.campaign_id
        GROUP BY campaigns.id
        ORDER BY campaigns.created_at DESC, campaigns.id DESC`;
    db.all(query, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/campaigns', (req, res) => {
    const { name, advertiser_id, start_date, end_date, status } = req.body;
    if (!name || !start_date || !end_date) {
        return res.status(400).json({ error: 'name, start_date and end_date are required' });
    }

    db.run(
        "INSERT INTO campaigns (name, advertiser_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [name, advertiser_id || null, start_date, end_date, status || 'active', new Date().toISOString()],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.post('/api/campaigns/:id/generate-tasks', (req, res) => {
    const campaignId = req.params.id;
    const { screen_ids } = req.body || {};
    const params = [];
    let where = '';
    if (Array.isArray(screen_ids) && screen_ids.length > 0) {
        where = `WHERE id IN (${screen_ids.map(() => '?').join(',')})`;
        params.push(...screen_ids);
    }

    db.all(`SELECT id FROM screens ${where}`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const stmt = db.prepare("INSERT OR IGNORE INTO campaign_screens (campaign_id, screen_id, status, updated_at) VALUES (?, ?, ?, ?)");
        rows.forEach(row => stmt.run(campaignId, row.id, 'not_started', new Date().toISOString()));
        stmt.finalize((stmtErr) => {
            if (stmtErr) return res.status(500).json({ error: stmtErr.message });
            res.json({ success: true, count: rows.length });
        });
    });
});

app.get('/api/campaigns/:id/tasks', (req, res) => {
    const query = `
        SELECT campaign_screens.*, screens.qr_code, buildings.name as building_name,
            buildings.lat, buildings.lng, assignments.operator_id, operators.name as operator_name,
            assignments.due_at,
            latest_photo.id as latest_photo_id, latest_photo.url as latest_photo_url, latest_photo.timestamp as latest_photo_timestamp
        FROM campaign_screens
        JOIN screens ON campaign_screens.screen_id = screens.id
        JOIN buildings ON screens.building_id = buildings.id
        LEFT JOIN assignments ON assignments.campaign_id = campaign_screens.campaign_id AND assignments.screen_id = campaign_screens.screen_id
        LEFT JOIN operators ON assignments.operator_id = operators.id
        LEFT JOIN photos latest_photo ON latest_photo.id = (
            SELECT id FROM photos
            WHERE photos.screen_id = campaign_screens.screen_id
            ORDER BY datetime(timestamp) DESC
            LIMIT 1
        )
        WHERE campaign_screens.campaign_id = ?
        ORDER BY buildings.name ASC, screens.id ASC`;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/assignments', (req, res) => {
    const { campaign_id, screen_ids, operator_id, due_at } = req.body;
    if (!campaign_id || !Array.isArray(screen_ids) || screen_ids.length === 0 || !operator_id) {
        return res.status(400).json({ error: 'campaign_id, screen_ids and operator_id are required' });
    }

    db.serialize(() => {
        const deleteStmt = db.prepare("DELETE FROM assignments WHERE campaign_id = ? AND screen_id = ?");
        const insertStmt = db.prepare(
            `INSERT INTO assignments (campaign_id, screen_id, operator_id, due_at, route_order, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        screen_ids.forEach((screenId, idx) => {
            deleteStmt.run(campaign_id, screenId);
            insertStmt.run(campaign_id, screenId, operator_id, due_at || null, idx + 1, 'assigned', new Date().toISOString());
        });
        deleteStmt.finalize();
        insertStmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, count: screen_ids.length });
        });
    });
});

app.get('/api/dashboard/exceptions', (req, res) => {
    const query = `
        SELECT photos.*, screens.qr_code, buildings.name as building_name,
            operators.name as operator_name, advertisers.name as advertiser_name
        FROM photos
        JOIN screens ON photos.screen_id = screens.id
        JOIN buildings ON screens.building_id = buildings.id
        JOIN operators ON photos.operator_id = operators.id
        LEFT JOIN advertisers ON photos.advertiser_id = advertisers.id
        WHERE photos.status IN ('flagged', 'rejected')
           OR photos.advertiser_id IS NULL
        ORDER BY datetime(photos.timestamp) DESC
        LIMIT 50`;
    db.all(query, (err, rows) => {
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
            db.get("SELECT screen_id FROM photos WHERE id = ?", [photo_id], (photoErr, row) => {
                if (!photoErr && row) updateCampaignScreenStatus(row.screen_id, status);
            });
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
        updateCampaignScreenStatus(screen_id, 'captured');
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
        const manifestRows = [
            ['photo_id', 'advertiser', 'building', 'screen_id', 'timestamp', 'lat', 'lng', 'status', 'source_url', 'exported_filename']
        ];

        rows.forEach(row => {
            const adv = sanitizeFilePart(row.adv_name || 'Unassigned');
            const bld = sanitizeFilePart(row.bld_name || 'Unknown');

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

            manifestRows.push([
                row.id,
                row.adv_name || 'Unassigned',
                row.bld_name || 'Unknown',
                row.screen_id,
                row.timestamp,
                row.lat,
                row.lng,
                row.status,
                row.url,
                newFileName
            ]);
        });

        const exportedAt = new Date().toISOString();
        const manifestName = `manifest_${exportedAt.replace(/T/, '_').replace(/:/g, '').split('.')[0]}.csv`;
        const manifestPath = path.join(exportDir, manifestName);
        fs.writeFileSync(
            manifestPath,
            manifestRows.map(row => row.map(csvEscape).join(',')).join('\n')
        );

        db.run(
            `INSERT INTO export_batches (photo_count, success_count, created_at, note, manifest_path) VALUES (?, ?, ?, ?, ?)`,
            [photo_ids.length, successCount, exportedAt, `Manual export from dashboard/mobile`, `/exported/${manifestName}`]
        );
        db.run(
            `UPDATE photos SET status = 'exported', exported_at = ? WHERE id IN (${photo_ids.map(() => '?').join(',')})`,
            [exportedAt, ...photo_ids]
        );
        rows.forEach(row => updateCampaignScreenStatus(row.screen_id, 'exported'));

        res.json({
            success: true,
            count: successCount,
            manifest: `/exported/${manifestName}`,
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
