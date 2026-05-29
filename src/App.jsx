import { useEffect, useRef, useState } from 'react';

const createUploadItem = (file) => ({
  id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}`,
  file,
  name: file.name,
  type: file.type,
  size: file.size,
  progress: 0,
  status: 'pending',
  error: '',
});

const formatSize = (value) => {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} bytes`;
};

function App() {
  const [uploadQueue, setUploadQueue] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const fetchDocuments = async () => {
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      setDocuments(data.files || []);
    } catch {
      setDocuments([]);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  const addFiles = (files) => {
    setError('');
    const pdfFiles = Array.from(files).filter((file) => file.type === 'application/pdf');

    if (pdfFiles.length === 0) {
      setError('Please select at least one PDF file.');
      return;
    }

    const newItems = pdfFiles.map(createUploadItem);
    setUploadQueue((current) => [...current, ...newItems]);
  };

  const handleFileSelection = (event) => {
    addFiles(event.target.files);
    event.target.value = null;
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = () => {
    setDragActive(false);
  };

  const updateItem = (id, changes) => {
    setUploadQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item))
    );
  };

  const uploadFile = (item) => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('documents', item.file);

      xhr.open('POST', '/api/upload');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          updateItem(item.id, { progress, status: 'uploading' });
        }
      };

      xhr.onload = async () => {
        if (xhr.status === 200) {
          updateItem(item.id, { progress: 100, status: 'complete' });
          resolve();
        } else {
          const message = xhr.responseText || 'Upload failed';
          updateItem(item.id, { status: 'failed', error: message });
          resolve();
        }
      };

      xhr.onerror = () => {
        updateItem(item.id, { status: 'failed', error: 'Upload request failed' });
        resolve();
      };

      xhr.send(formData);
    });
  };

  const handleUpload = async () => {
    setError('');
    const pendingItems = uploadQueue.filter((item) => item.status === 'pending' || item.status === 'failed');
    if (pendingItems.length === 0) {
      setError('No files ready for upload.');
      return;
    }

    for (const item of pendingItems) {
      updateItem(item.id, { status: 'uploading', progress: 0, error: '' });
      await uploadFile(item);
    }

    await fetchDocuments();
  };

  const handleRetry = async (itemId) => {
    const item = uploadQueue.find((file) => file.id === itemId);
    if (!item) return;
    updateItem(itemId, { status: 'pending', progress: 0, error: '' });
    await uploadFile(item);
    await fetchDocuments();
  };

  const downloadUrl = (filename) => `/api/download/${encodeURIComponent(filename)}`;

  return (
    <main className="app-shell">
      <section className="upload-card">
        <div className="upload-header">
          <div>
            <h1>Document Upload</h1>
            <p>Choose one or more PDFs, or drop them into the upload area. Each file shows its own progress and status.</p>
          </div>
          <button type="button" className="upload-button" onClick={handleUpload}>
            Upload Selected Files
          </button>
        </div>

        <div
          className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <p>Drag & drop PDF files here, or click to browse.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            onChange={handleFileSelection}
            className="hidden-input"
          />
        </div>

        {error && <p className="status error">{error}</p>}

        <div className="upload-list">
          {uploadQueue.length === 0 ? (
            <p className="empty-state">No files selected yet.</p>
          ) : (
            uploadQueue.map((item) => (
              <article key={item.id} className="upload-item">
                <div className="upload-item-main">
                  <div>
                    <h2>{item.name}</h2>
                    <p>{formatSize(item.size)} · {item.type || 'PDF'}</p>
                  </div>
                  <div className="upload-status-label">{item.status}</div>
                </div>

                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                </div>
                <div className="upload-meta">
                  <span>{item.progress}%</span>
                  {item.status === 'failed' && (
                    <button type="button" className="retry-button" onClick={() => handleRetry(item.id)}>
                      Retry
                    </button>
                  )}
                </div>
                {item.error && <p className="status error small">{item.error}</p>}
              </article>
            ))
          )}
        </div>
      </section>

      <section className="document-table-card">
        <h2>Uploaded Documents</h2>
        {documents.length === 0 ? (
          <p className="empty-state">No uploaded documents found yet.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.name}>
                    <td>{doc.name}</td>
                    <td>{formatSize(doc.size)}</td>
                    <td>{new Date(doc.uploadDate).toLocaleString()}</td>
                    <td>
                      <a className="download-link" href={downloadUrl(doc.name)}>
                        Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
