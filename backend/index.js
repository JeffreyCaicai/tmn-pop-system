const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = 3001;

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
        FOREIGN KEY(screen_id) REFERENCES screens(id),
        FOREIGN KEY(operator_id) REFERENCES operators(id),
        FOREIGN KEY(advertiser_id) REFERENCES advertisers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS advertisers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
    )`);

    // Seed some initial data
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B001', 'Wisma Thamrin', -6.189, 106.823)");
    db.run("INSERT OR IGNORE INTO buildings VALUES ('B002', 'Sudirman Tower', -6.215, 106.816)");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S001', 'B001', 'QR_S001')");
    db.run("INSERT OR IGNORE INTO screens VALUES ('S002', 'B001', 'QR_S002')");
    db.run("INSERT OR IGNORE INTO operators VALUES ('OP01', 'Budi', 'Central')");
    
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
    db.run("UPDATE photos SET advertiser_id = ? WHERE id = ?", [advertiser_id, photo_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
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
    const query = `SELECT 
        (SELECT COUNT(*) FROM screens) as total_screens,
        (SELECT COUNT(*) FROM photos) as completed_photos`;
    db.get(query, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// Get all photos
app.get('/api/dashboard/photos', (req, res) => {
    const query = `
        SELECT photos.*, screens.qr_code, buildings.name as building_name, operators.name as operator_name, advertisers.name as advertiser_name
        FROM photos
        JOIN screens ON photos.screen_id = screens.id
        JOIN buildings ON screens.building_id = buildings.id
        JOIN operators ON photos.operator_id = operators.id
        LEFT JOIN advertisers ON photos.advertiser_id = advertisers.id
        ORDER BY photos.timestamp DESC`;
    db.all(query, (err, rows) => {
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
            const adv = (row.adv_name || 'Unassigned').replace(/\s+/g, '-');
            const bld = (row.bld_name || 'Unknown').replace(/\s+/g, '-');
            const time = row.timestamp.replace(/[:T]/g, '-').split('.')[0];
            // Added ID to filename to ensure uniqueness
            const newFileName = `${adv}_${bld}_${time}_ID${row.id}.jpg`;
            
            const relativeUrl = row.url.replace(/^\//, '');
            const sourcePath = path.join(__dirname, relativeUrl);
            const destPath = path.join(exportDir, newFileName);
            
            if (fs.existsSync(sourcePath)) {
                fs.copyFileSync(sourcePath, destPath);
                successCount++;
                console.log(`[SUCCESS] ${row.id} synced as ${newFileName}`);
            } else {
                console.warn(`[FAILED] ${row.id} source file not found at ${sourcePath}`);
            }
        });

        res.json({ 
            success: true, 
            count: successCount, 
            message: `Successfully synced ${successCount} photos to exported folder.` 
        });
    });
});

https.createServer(options, app).listen(PORT, () => {
    console.log(`Backend running at https://localhost:${PORT}`);
    console.log(`NOTE: If accessing from mobile, use your computer's IP address (e.g., https://192.168.1.5:3001)`);
});

