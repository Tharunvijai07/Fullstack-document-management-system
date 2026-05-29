const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const mime = require('mime-types');

const app = express();
const server = http.createServer(app);
const uploadFolder = path.join(__dirname, 'uploads');
const dbFile = path.join(__dirname, 'data.db');

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

const db = new sqlite3.Database(dbFile);

function initDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      uploadDate INTEGER NOT NULL,
      status TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    )`);
  });
}

initDatabase();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename: (req, file, cb) => {
    const base = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${base}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF uploads are allowed'), false);
    }
    cb(null, true);
  },
  limits: {
    fileSize: 150 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  const files = req.files.map(file => ({
    name: file.originalname,
    path: file.filename,
    size: file.size,
    mime: file.mimetype,
    uploadDate: Date.now(),
    status: req.files.length > 3 ? 'processing' : 'ready'
  }));

  const stmt = db.prepare(`INSERT INTO documents (name, path, size, mime, uploadDate, status) VALUES (?, ?, ?, ?, ?, ?)`);
  db.serialize(() => {
    files.forEach(file => {
      stmt.run(file.name, file.path, file.size, file.mime, file.uploadDate, file.status);
    });
    stmt.finalize(err => {
      if (err) {
        console.error('Failed to save document metadata', err);
        return res.status(500).json({ error: 'Could not save document metadata.' });
      }

      const response = {
        files: files.map(file => ({
          name: file.name,
          size: file.size,
          mime: file.mime,
          status: file.status
        })),
        bulk: files.length > 3,
        count: files.length
      };

      if (files.length > 3) {
        broadcast({
          type: 'bulk-processing-started',
          count: files.length,
          message: `Upload in progress — processing ${files.length} files in background.`
        });

        setTimeout(() => {
          db.run(`UPDATE documents SET status = 'ready' WHERE status = 'processing' AND uploadDate >= ?`, [files[0].uploadDate], updateErr => {
            if (updateErr) {
              console.error('Failed to update processing documents', updateErr);
              return;
            }
            const successMessage = `${files.length} files uploaded successfully.`;
            saveNotification(successMessage, 'success');
            broadcast({
              type: 'bulk-processing-complete',
              count: files.length,
              message: successMessage,
              timestamp: Date.now()
            });
          });
        }, 2000 + files.length * 500);
      }

      res.json(response);
    });
  });
});

app.get('/api/documents', (req, res) => {
  db.all(`SELECT id, name, size, mime, uploadDate, status FROM documents ORDER BY uploadDate DESC`, [], (err, rows) => {
    if (err) {
      console.error('Failed to fetch documents', err);
      return res.status(500).json({ error: 'Unable to load documents.' });
    }
    res.json(rows.map(row => ({
      ...row,
      uploadDate: row.uploadDate,
      status: row.status
    })));
  });
});

app.get('/api/documents/:id/download', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.get(`SELECT name, path, mime FROM documents WHERE id = ?`, [id], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    const filePath = path.join(uploadFolder, row.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk.' });
    }
    res.download(filePath, row.name);
  });
});

app.get('/api/notifications', (req, res) => {
  db.all(`SELECT id, message, type, timestamp, read FROM notifications ORDER BY timestamp DESC`, [], (err, rows) => {
    if (err) {
      console.error('Failed to load notifications', err);
      return res.status(500).json({ error: 'Unable to load notifications.' });
    }
    res.json(rows);
  });
});

app.post('/api/notifications/mark-read', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Notification id is required.' });
  }
  db.run(`UPDATE notifications SET read = 1 WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error('Failed to update notification', err);
      return res.status(500).json({ error: 'Unable to mark notification as read.' });
    }
    res.json({ success: true });
  });
});

app.post('/api/notifications/mark-all-read', (req, res) => {
  db.run(`UPDATE notifications SET read = 1 WHERE read = 0`, [], function (err) {
    if (err) {
      console.error('Failed to mark notifications read', err);
      return res.status(500).json({ error: 'Unable to mark notifications as read.' });
    }
    res.json({ success: true });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function saveNotification(message, type) {
  db.run(`INSERT INTO notifications (message, type, timestamp, read) VALUES (?, ?, ?, 0)`, [message, type, Date.now()], err => {
    if (err) {
      console.error('Failed to save notification', err);
    }
  });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Document Management Dashboard running on http://localhost:${port}`);
});
