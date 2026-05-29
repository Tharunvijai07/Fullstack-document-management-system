// 1. CRITICAL: Load environment configurations first thing
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v2 as cloudinary } from 'cloudinary';

// Setup file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
const metadataFile = path.join(dataDir, 'files.json');

// Ensure storage directories exist safely on startup
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const port = process.env.PORT || 5000;
const clients = new Set();

app.use(cors());
app.use(express.json());

// Initialize Cloudinary
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("☁️ Cloudinary Configuration loaded successfully.");
} else {
  console.error("❌ Cloudinary variables missing from your .env file!");
}

// Setup local disk buffer storage for Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({ storage, fileFilter });

// SSE Server-Sent Events Core Setup
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
  req.on('close', () => clients.delete(res));
});

/* ==========================================================================
   🚀 MAIN CLOUDINARY UPLOAD ROUTE
   ========================================================================== */
app.post('/api/upload', upload.array('documents'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No documents were uploaded.' });
  }

  const uploadResults = [];
  const uploadErrors = [];

  // Sequential processing loop using for...of to prevent thread blocking
  for (const file of req.files) {
    try {
      // Stream file from local disk buffer directly up to Cloudinary
      const result = await cloudinary.uploader.upload(file.path, {
        resource_type: 'raw', // Mandatory flag config to handle raw PDF structures
        folder: 'pdf_dashboard_vault',
      });

      const fileMetadata = {
        id: result.public_id,
        name: file.originalname,
        size: file.size,
        url: result.secure_url, // Your permanent CDN live viewing link
        uploadDate: new Date().toISOString(),
      };

      // Read current JSON DB file records
      let currentRecords = [];
      if (fs.existsSync(metadataFile)) {
        const rawData = await fs.promises.readFile(metadataFile, 'utf8');
        currentRecords = JSON.parse(rawData || '[]');
      }

      // Add new record to front of array and save
      currentRecords.unshift(fileMetadata);
      await fs.promises.writeFile(metadataFile, JSON.stringify(currentRecords, null, 2), 'utf8');
      uploadResults.push(fileMetadata);

    } catch (error) {
      console.error(`Upload error for ${file.originalname}:`, error);
      uploadErrors.push({ name: file.originalname, error: error.message });
    } finally {
      // ⚠️ CLEANUP: Always remove temporary buffer file from local server storage
      if (fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path).catch(() => {});
      }
    }
  }

  // Push updates over Server Sent Events if successful
  if (uploadResults.length > 0) {
    sendSse('uploadComplete', {
      count: uploadResults.length,
      message: `${uploadResults.length} files stored securely on cloud storage.`,
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: uploadResults, failed: uploadErrors });
});

// Fetch all uploaded files list endpoint
app.get('/api/files', async (req, res) => {
  try {
    if (fs.existsSync(metadataFile)) {
      const raw = await fs.promises.readFile(metadataFile, 'utf8');
      return res.json({ files: JSON.parse(raw || '[]') });
    }
    res.json({ files: [] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to retrieve cloud asset file listing.' });
  }
});

app.listen(port, () => {
  console.log(`🚀 File Server running at http://localhost:${port}`);
});
