import { useEffect, useMemo, useRef, useState } from 'react';

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
  const [docsLoading, setDocsLoading] = useState(false);
  const [backgroundNotice, setBackgroundNotice] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [collapsedBulk, setCollapsedBulk] = useState(true);
  const fileInputRef = useRef(null);

  const fetchDocuments = async () => {
    setDocsLoading(true);
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      setDocuments(data.files || []);
    } catch {
      setDocuments([]);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const eventSource = new EventSource('/api/events');

    eventSource.addEventListener('uploadComplete', (event) => {
      const payload = JSON.parse(event.data);
      const message = payload.message || `${payload.count} files uploaded successfully.`;
      const timestamp = payload.timestamp || new Date().toISOString();

      setNotifications((current) => [
        { id: `${payload.count}-${timestamp}`, message, timestamp },
        ...current,
      ]);

      if (window.Notification && Notification.permission === 'granted') {
        new Notification(message, { body: `Completed at ${new Date(timestamp).toLocaleTimeString()}` });
      }

      setBackgroundNotice('');
      fetchDocuments();
    });

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
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
    return new Promise(async (resolve) => {
      try {
        // Request a signature from the server
        const sigRes = await fetch('/api/cloudinary/sign');
        if (!sigRes.ok) {
          updateItem(item.id, { status: 'failed', error: 'Unable to get upload signature' });
          return resolve();
        }

        const { signature, timestamp, apiKey, cloudName } = await sigRes.json();

        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        // For PDFs, Cloudinary uses resource_type 'raw'
        formData.append('file', item.file);
        formData.append('api_key', apiKey);
        formData.append('timestamp', timestamp);
        formData.append('signature', signature);
        formData.append('resource_type', 'raw');

        const url = `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`;

        xhr.open('POST', url);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            updateItem(item.id, { progress, status: 'uploading' });
          }
        };

        xhr.onload = async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            updateItem(item.id, { progress: 100, status: 'complete' });
            try {
              const result = JSON.parse(xhr.responseText);
              // Persist metadata to backend
              await fetch('/api/files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: result.original_filename || item.name,
                  size: result.bytes || item.size,
                  uploadDate: result.created_at || new Date().toISOString(),
                  url: result.secure_url,
                  public_id: result.public_id,
                  resource_type: result.resource_type,
                }),
              });
            } catch (e) {
              // ignore metadata save errors
            }
          } else {
            const message = xhr.responseText || 'Upload failed';
            updateItem(item.id, { status: 'failed', error: message });
          }
          resolve();
        };

        xhr.onerror = () => {
          updateItem(item.id, { status: 'failed', error: 'Upload request failed' });
          resolve();
        };

        xhr.send(formData);
      } catch (err) {
        updateItem(item.id, { status: 'failed', error: String(err) });
        resolve();
      }
    });
  };

  const uploadBulkFiles = async (items) => {
    // Upload sequentially to keep per-file progress and avoid huge form payloads
    for (const item of items) {
      await uploadFile(item);
    }
  };

  const handleUpload = async () => {
    setError('');
    const pendingItems = uploadQueue.filter((item) => item.status === 'pending' || item.status === 'failed');
    if (pendingItems.length === 0) {
      setError('No files ready for upload.');
      return;
    }

    if (pendingItems.length > 3) {
      setBackgroundNotice(`Upload in progress — processing ${pendingItems.length} files in background.`);
      setCollapsedBulk(true);
      pendingItems.forEach((item) => updateItem(item.id, { status: 'uploading', progress: 0, error: '' }));
      await uploadBulkFiles(pendingItems);
    } else {
      setBackgroundNotice('');
      for (const item of pendingItems) {
        updateItem(item.id, { status: 'uploading', progress: 0, error: '' });
        await uploadFile(item);
      }
      await fetchDocuments();
    }
  };

  const handleRetry = async (itemId) => {
    const item = uploadQueue.find((file) => file.id === itemId);
    if (!item) return;
    updateItem(itemId, { status: 'pending', progress: 0, error: '' });
    await uploadFile(item);
    await fetchDocuments();
  };

  const downloadUrl = (filename) => `/api/download/${encodeURIComponent(filename)}`;

  const uploadingAny = useMemo(
    () => uploadQueue.some((item) => item.status === 'uploading'),
    [uploadQueue]
  );

  const pendingItems = useMemo(
    () => uploadQueue.filter((item) => item.status === 'pending' || item.status === 'failed'),
    [uploadQueue]
  );

  const isBulkUpload = pendingItems.length > 3 || backgroundNotice;

  return (
    <main className="app-shell">
      <section className="upload-card">
        <div className="upload-header">
          <div>
            <h1>Upload PDF Documents</h1>
            <p>Drag & drop one or more PDF files</p>
          </div>
          <button
            type="button"
            className="upload-button"
            onClick={handleUpload}
            disabled={pendingItems.length === 0 || uploadingAny}
          >
            {uploadingAny ? (
              <>
                <span className="spinner" /> Uploading...
              </>
            ) : (
              'Upload Selected Files'
            )}
          </button>
        </div>

        {backgroundNotice && (
          <div className="bulk-banner">
            <div>
              <strong>{backgroundNotice}</strong>
              <p className="bulk-banner-note">Individual progress remains visible below in a compact view.</p>
            </div>
            <button
              type="button"
              className="link-button"
              onClick={() => setCollapsedBulk((value) => !value)}
            >
              {collapsedBulk ? 'Show details' : 'Hide details'}
            </button>
          </div>
        )}

        <div
          className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div>
            <p className="drop-title">Drop PDFs here</p>
            <p className="drop-subtitle">or click to choose files</p>
          </div>
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

        <div className={`upload-list ${isBulkUpload && collapsedBulk ? 'bulk-collapsed' : ''}`}>
          {uploadQueue.length === 0 ? (
            <p className="empty-state">No files selected yet. Add PDFs to begin.</p>
          ) : (
            uploadQueue.map((item) => (
              <article key={item.id} className={`upload-item ${isBulkUpload ? 'bulk-item' : ''}`}>
                <div className="upload-item-main">
                  <div>
                    <h2>{item.name}</h2>
                    {!collapsedBulk && <p>{formatSize(item.size)} · {item.type || 'PDF'}</p>}
                  </div>
                  <div className={`status-pill status-${item.status}`}>{item.status}</div>
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
                {!collapsedBulk && item.error && <p className="status error small">{item.error}</p>}
              </article>
            ))
          )}
        </div>
      </section>

      <section className="document-table-card">
        <div className="table-header">
          <div>
            <p className="eyebrow">Uploaded Documents</p>
            <h2>Files stored in backend</h2>
          </div>
          {docsLoading && (
            <div className="small-loader">
              <span className="spinner small" /> Refreshing list...
            </div>
          )}
        </div>

        {docsLoading ? (
          <p className="empty-state">Loading documents...</p>
        ) : documents.length === 0 ? (
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

      <aside className="notification-pane">
        {notifications.map((note) => (
          <div key={note.id} className="toast-notification">
            <strong>{note.message}</strong>
            <span>{new Date(note.timestamp).toLocaleTimeString()}</span>
          </div>
        ))}
      </aside>
    </main>
  );
}

export default App;
