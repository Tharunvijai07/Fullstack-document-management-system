const uploadButton = document.getElementById('uploadButton');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const uploadList = document.getElementById('uploadList');
const documentRows = document.getElementById('documentRows');
const notificationToggle = document.getElementById('notificationToggle');
const notificationPanel = document.getElementById('notificationPanel');
const notificationList = document.getElementById('notificationList');
const notificationsPageList = document.getElementById('notificationsPageList');
const badge = document.getElementById('badge');
const markAllRead = document.getElementById('markAllRead');
const pageMarkAllRead = document.getElementById('pageMarkAllRead');
const toast = document.getElementById('toast');
const bulkBanner = document.getElementById('bulkBanner');
const toggleProgress = document.getElementById('toggleProgress');
const tabButtons = document.querySelectorAll('.tab-button');

let notifications = [];
let unreadCount = 0;
let activeUploads = [];
let progressCollapsed = false;
let ws;

const state = {
  activeTab: 'upload'
};

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.page-section').forEach(section => {
    section.classList.toggle('active', section.id === tab);
  });
  tabButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function updateBadge() {
  badge.textContent = unreadCount > 0 ? unreadCount : '0';
  badge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
}

function renderNotifications(listRoot, items) {
  listRoot.innerHTML = '';
  if (!items.length) {
    listRoot.innerHTML = '<div class="notification-item"><p>No notifications yet.</p></div>';
    return;
  }
  items.forEach(note => {
    const item = document.createElement('div');
    item.className = `notification-item ${note.read ? '' : 'unread'}`;
    item.innerHTML = `
      <div class="notification-item-header">
        <strong>${note.type === 'success' ? 'Success' : note.type === 'error' ? 'Error' : 'Info'}</strong>
        <small>${formatDate(note.timestamp)}</small>
      </div>
      <p>${note.message}</p>
      <div class="notification-actions">
        ${note.read ? '' : '<button class="link-button small" data-action="mark-read" data-id="' + note.id + '">Mark read</button>'}
      </div>
    `;
    listRoot.appendChild(item);
  });
}

function loadNotifications() {
  fetch('/api/notifications')
    .then(res => res.json())
    .then(data => {
      notifications = data;
      unreadCount = notifications.filter(note => note.read === 0).length;
      updateBadge();
      renderNotifications(notificationList, notifications);
      renderNotifications(notificationsPageList, notifications);
    })
    .catch(() => showToast('Unable to load notifications.'));
}

function markNotificationRead(id) {
  fetch('/api/notifications/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
    .then(res => res.json())
    .then(() => loadNotifications())
    .catch(() => showToast('Unable to update notification status.'));
}

function markAllNotificationsRead() {
  fetch('/api/notifications/mark-all-read', { method: 'POST' })
    .then(res => res.json())
    .then(() => loadNotifications())
    .catch(() => showToast('Unable to mark all notifications read.'));
}

function renderDocuments(items) {
  documentRows.innerHTML = '';
  if (!items.length) {
    documentRows.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 28px 0; color:#6b7280;">No documents uploaded yet.</td></tr>';
    return;
  }
  items.forEach((doc) => {
    const row = document.createElement('tr');
    const statusClass = doc.status === 'ready' ? 'status-ready' : doc.status === 'processing' ? 'status-processing' : 'status-failed';
    row.innerHTML = `
      <td>${doc.name}</td>
      <td>${formatBytes(doc.size)}</td>
      <td>${doc.mime}</td>
      <td>${formatDate(doc.uploadDate)}</td>
      <td><span class="status-chip ${statusClass}">${doc.status}</span></td>
      <td><a class="link-button small" href="/api/documents/${doc.id}/download">Download</a></td>
    `;
    documentRows.appendChild(row);
  });
}

function loadDocuments() {
  fetch('/api/documents')
    .then(res => res.json())
    .then(renderDocuments)
    .catch(() => showToast('Unable to load documents.'));
}

function addUploadItem(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';
  item.dataset.name = file.name;
  item.innerHTML = `
    <div class="upload-item-header">
      <div>
        <strong>${file.name}</strong>
        <div class="upload-meta">
          <span>${formatBytes(file.size)}</span>
          <span>${file.type}</span>
          <span class="status-text">Pending</span>
        </div>
      </div>
      <strong class="progress-value">0%</strong>
    </div>
    <div class="progress-bar"><span style="width: 0%"></span></div>
  `;
  uploadList.appendChild(item);
  return item;
}

function setUploadProgress(item, percent, status) {
  const bar = item.querySelector('.progress-bar span');
  const percentText = item.querySelector('.progress-value');
  const statusText = item.querySelector('.status-text');
  bar.style.width = `${percent}%`;
  percentText.textContent = `${Math.round(percent)}%`;
  statusText.textContent = status;
}

function uploadFiles(files) {
  if (!files || !files.length) {
    showToast('Please select at least one PDF file.');
    return;
  }
  const pdfFiles = Array.from(files).filter(file => file.type === 'application/pdf');
  if (!pdfFiles.length) {
    showToast('Only PDF files are supported.');
    return;
  }

  uploadList.innerHTML = '';
  activeUploads = pdfFiles.map(file => ({ file, item: addUploadItem(file) }));
  progressCollapsed = pdfFiles.length > 3;
  bulkBanner.classList.toggle('hidden', !progressCollapsed);
  toggleProgress.classList.toggle('hidden', !progressCollapsed);
  toggleProgress.textContent = progressCollapsed ? 'Show progress' : 'Hide progress';

  if (progressCollapsed) {
    bulkBanner.textContent = `Upload in progress — processing ${pdfFiles.length} files in background.`;
  }

  const uploadPromises = activeUploads.map(upload => {
    return new Promise((resolve) => {
      const formData = new FormData();
      formData.append('files', upload.file, upload.file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);

      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const percent = (event.loaded / event.total) * 100;
        setUploadProgress(upload.item, percent, 'Uploading');
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(upload.item, 100, 'Complete');
          resolve({ success: true, response: JSON.parse(xhr.responseText) });
        } else {
          setUploadProgress(upload.item, 0, 'Failed');
          resolve({ success: false });
        }
      };

      xhr.onerror = () => {
        setUploadProgress(upload.item, 0, 'Failed');
        resolve({ success: false });
      };

      xhr.send(formData);
    });
  });

  Promise.all(uploadPromises).then(results => {
    const successCount = results.filter(result => result.success).length;
    const bulk = pdfFiles.length > 3;
    showToast(`Uploaded ${successCount} of ${pdfFiles.length} file${pdfFiles.length > 1 ? 's' : ''}.`);
    loadDocuments();
    if (!bulk) {
      setTimeout(() => loadNotifications(), 300);
    }
  });
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${window.location.host}/ws`;
  ws = new WebSocket(url);
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'bulk-processing-started') {
      showToast(payload.message);
    }
    if (payload.type === 'bulk-processing-complete') {
      showToast(payload.message);
      loadDocuments();
      loadNotifications();
    }
  });
  ws.addEventListener('close', () => {
    setTimeout(initWebSocket, 3000);
  });
}

uploadButton.addEventListener('click', () => {
  uploadFiles(fileInput.files);
});

dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  dropZone.classList.add('drop-zone-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drop-zone-over');
});

dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drop-zone-over');
  const files = Array.from(event.dataTransfer.files);
  fileInput.files = event.dataTransfer.files;
  uploadFiles(files);
});

notificationToggle.addEventListener('click', () => {
  notificationPanel.classList.toggle('hidden');
});

markAllRead.addEventListener('click', markAllNotificationsRead);
pageMarkAllRead.addEventListener('click', markAllNotificationsRead);

notificationList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action="mark-read"]');
  if (!button) return;
  markNotificationRead(button.dataset.id);
});

notificationsPageList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action="mark-read"]');
  if (!button) return;
  markNotificationRead(button.dataset.id);
});

toggleProgress.addEventListener('click', () => {
  progressCollapsed = !progressCollapsed;
  uploadList.style.display = progressCollapsed ? 'none' : 'grid';
  toggleProgress.textContent = progressCollapsed ? 'Show progress' : 'Hide progress';
});

tabButtons.forEach(button => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

window.addEventListener('click', (event) => {
  if (!notificationPanel.contains(event.target) && event.target !== notificationToggle) {
    notificationPanel.classList.add('hidden');
  }
});

window.addEventListener('load', () => {
  setActiveTab('upload');
  loadDocuments();
  loadNotifications();
  initWebSocket();
});
