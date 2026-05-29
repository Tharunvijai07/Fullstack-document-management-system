import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();
const port = process.env.PORT || 5000;
const clients = new Set();

app.use(cors());
app.use(express.json());

dotenv.config();

// Configure Cloudinary from environment
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({ storage, fileFilter });

const sendSse = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
};

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('retry: 2000\n\n');
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/api/upload', upload.array('documents'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No documents were uploaded.');
  }

  const uploadCount = req.files.length;
  if (uploadCount > 3) {
    setTimeout(() => {
      sendSse('uploadComplete', {
        count: uploadCount,
        message: `${uploadCount} files uploaded successfully`,
        timestamp: new Date().toISOString(),
      });
    }, 1200);
  }

  res.json({ uploaded: req.files.map((file) => file.originalname), count: uploadCount });
});

// Return a signed payload for direct browser uploads to Cloudinary (raw/resource_type)
app.get('/api/cloudinary/sign', (req, res) => {
  if (!cloudinary.config().api_key) {
    return res.status(500).json({ error: 'Cloudinary is not configured on the server.' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  // Sign with resource_type raw for PDFs
  const paramsToSign = { timestamp, resource_type: 'raw' };
  // Use the API secret from environment
  const signature = cloudinary.utils.api_sign_request(paramsToSign, cloudinary.config().api_secret);

  res.json({
    signature,
    timestamp,
    apiKey: cloudinary.config().api_key,
    cloudName: cloudinary.config().cloud_name,
  });
});

// Simple metadata store for uploaded files (appends to data/files.json)
const dataDir = path.join(__dirname, 'data');
const metadataFile = path.join(dataDir, 'files.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.post('/api/files', async (req, res) => {
  const meta = req.body;
  if (!meta || !meta.name) return res.status(400).json({ error: 'Missing metadata' });

  let list = [];
  try {
    if (fs.existsSync(metadataFile)) {
      const raw = await fs.promises.readFile(metadataFile, 'utf8');
      list = JSON.parse(raw || '[]');
    }
  } catch (e) {
    list = [];
  }

  list.unshift(meta);
  try {
    await fs.promises.writeFile(metadataFile, JSON.stringify(list, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write metadata' });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    // Prefer metadata file if present (Cloudinary uploads)
    if (fs.existsSync(metadataFile)) {
      const raw = await fs.promises.readFile(metadataFile, 'utf8');
      const metaList = JSON.parse(raw || '[]');
      return res.json({ files: metaList });
    }

    // Fallback to local uploads folder
    const items = await fs.promises.readdir(uploadDir);
    const files = await Promise.all(
      items.map(async (name) => {
        const filePath = path.join(uploadDir, name);
        const stats = await fs.promises.stat(filePath);
        return {
          name,
          size: stats.size,
          uploadDate: stats.mtime,
        };
      })
    );

    res.json({ files: files.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate)) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to read uploaded files.' });
  }
});

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  res.download(filePath, filename);
});

app.listen(port, () => {
  console.log(`Upload server listening on http://localhost:${port}`);
});
