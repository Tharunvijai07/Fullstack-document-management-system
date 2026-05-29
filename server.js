import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

app.post('/api/upload', upload.array('documents'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No documents were uploaded.');
  }

  res.json({ uploaded: req.files.map((file) => file.originalname) });
});

app.get('/api/files', async (req, res) => {
  try {
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
