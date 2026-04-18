const DB_NAME = 'likesArchive';
const DB_VERSION = 3;
let db;
let currentItem = null;
let currentCols = 2;
let currentTab = 'general';
let currentBoard = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('likes')) {
        db.createObjectStore('likes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('deleted')) {
        db.createObjectStore('deleted', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('boards')) {
        db.createObjectStore('boards', { keyPath: 'id' });
      }
    };
    request.onsuccess = e => resolve(e.target.result);
    request.onerror = e => reject(e);
  });
}

function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function parseCSV(text) {
  const results = [];
  const lines = text.split('\n');
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = [];
    let current = '';
    let inQuotes = false;
    
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c+1] === '"') {
          current += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cols.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cols.push(current);

    const id = cols[1]?.trim();
    const date = cols[2]?.trim();
    const username = cols[3]?.trim();
    const displayName = cols[4]?.trim();
    const text = cols[5]?.trim();
    const mediaRaw = cols[17]?.trim();

    if (!id) continue;

    const images = mediaRaw
      ? mediaRaw.split(';').map(u => u.trim()).filter(u => u.startsWith('http'))
      : [];

    results.push({ id, date, username, displayName, text, images });
  }

  return results;
}

async function downloadAndStoreImage(url, id, index) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function importFiles(files) {
  const deletedAll = await dbGetAll('deleted');
  const deletedIds = new Set(deletedAll.map(d => d.id));

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await file.text();
    let entries;

    if (file.name.endsWith('.csv')) {
      entries = parseCSV(text);
    } else {
      try {
        const cleaned = text
          .replace(/^window\.YTD\.like\.part\d+\s*=\s*/, '')
          .replace(/^window\.YTD\.bookmark\.part\d+\s*=\s*/, '')
          .trim();
        const json = JSON.parse(cleaned);
        entries = json.map(entry => {
          const item = entry.like || entry.bookmark;
          return {
            id: item.tweetId,
            text: item.fullText || '',
            username: '',
            displayName: '',
            date: '',
            images: []
          };
        });
      } catch {
        alert(`Could not read ${file.name}. Skipping.`);
        continue;
      }
    }

    for (const entry of entries) {
      if (!entry.id) continue;
      if (deletedIds.has(entry.id)) { skipped++; continue; }
      const existing = await dbGet('likes', entry.id);
      if (existing) { skipped++; continue; }

      const storedImages = [];
      for (let i = 0; i < entry.images.length; i++) {
        const data = await downloadAndStoreImage(entry.images[i], entry.id, i);
        if (data) {
          await dbPut('images', { id: `${entry.id}_${i}`, data });
          storedImages.push(`${entry.id}_${i}`);
        }
      }

      await dbPut('likes', {
        id: entry.id,
        text: entry.text,
        username: entry.username,
        displayName: entry.displayName,
        date: entry.date,
        imageKeys: storedImages,
        board: null
      });

      imported++;
    }
  }

  alert(`Done. ${imported} new likes imported, ${skipped} skipped.`);
  renderGallery();
}

async function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;

  if (item.imageKeys && item.imageKeys.length > 0) {
    const imgRecord = await dbGet('images', item.imageKeys[0]);
    if (imgRecord) {
      const img = document.createElement('img');
      img.src = imgRecord.data;
      img.alt = item.text ? item.text.slice(0, 60) : '';
      img.loading = 'lazy';
      card.appendChild(img);
    }
  }

  if (item.text) {
    const p = document.createElement('div');
    p.className = 'card-text';
    p.textContent = item.text.slice(0, 140) + (item.text.length > 140 ? '...' : '');
    card.appendChild(p);
  }

  if (item.displayName || item.username) {
    const author = document.createElement('div');
    author.className = 'card-author';
    author.textContent = item.displayName || item.username;
    card.appendChild(author);
  }

  if (item.board) {
    const tag = document.createElement('div');
    tag.className = 'card-board-tag';
    tag.textContent = item.board;
    card.appendChild(tag);
  }

  card.addEventListener('click', () => openLightbox(item));
  return card;
}

async function renderGallery(filter = '') {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = '';

  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    !item.board &&
    (item.text || '').toLowerCase().includes(filter.toLowerCase())
  );

  updateCounter(filtered.length);

  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes yet. Tap Import to get started.</p>';
    return;
  }

  for (const item of filtered) {
    gallery.appendChild(await createCard(item));
  }
}

async function renderBoardGallery(boardName, filter = '') {
  const gallery = document.getElementById('board-gallery');
  gallery.innerHTML = '';

  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    item.board === boardName &&
    (item.text || '').toLowerCase().includes(filter.toLowerCase())
  );

  updateCounter(filtered.length);

  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes in this board yet.</p>';
    return;
  }

  for (const item of filtered) {
    gallery.appendChild(await createCard(item));
  }
}

async function renderBoards() {
  const boardsList = document.getElementById('boards-list');
  boardsList.innerHTML = '';

  const boards = await dbGetAll('boards');
  const likes = await dbGetAll('likes');

  if (boards.length === 0) {
    boardsList.innerHTML = '<p style="padding:20px;color:#666;">No boards yet. Open a like and tap "Add to board" to create one.</p>';
    return;
  }

  for (const board of boards) {
    const count = likes.filter(l => l.board === board.id).length;

    const item = document.createElement('div');
    item.className = 'board-item';

    const info = document.createElement('div');
    info.style.flex = '1';

    const name = document.createElement('div');
    name.className = 'board-name';
    name.textContent = board.id;

    const cnt = document.createElement('div');
    cnt.className = 'board-count';
    cnt.textContent = count + ' likes';

    info.appendChild(name);
    info.appendChild(cnt);

    const delBtn = document.createElement('button');
    delBtn.className = 'board-delete-btn';
    delBtn.textContent = '×';
    delBtn.onclick = async e => {
      e.stopPropagation();
      if (confirm(`Delete board "${board.id}"? Likes inside will be moved back to General.`)) {
        const all = await dbGetAll('likes');
        for (const like of all) {
          if (like.board === board.id) {
            like.board = null;
            await dbPut('likes', like);
          }
        }
        await dbDelete('boards', board.id);
        renderBoards();
      }
    };

    item.appendChild(info);
    item.appendChild(delBtn);
    item.addEventListener('click', () => openBoard(board.id));
    boardsList.appendChild(item);
  }
}

function openBoard(boardName) {
  currentBoard = boardName;
  document.getElementById('boards-list').classList.add('hidden');
  document.getElementById('board-contents').classList.remove('hidden');
  renderBoardGallery(boardName);
}

function updateCounter(count) {
  document.getElementById('like-counter').textContent = count + ' likes';
}

async function openLightbox(item) {
  currentItem = item;

  const text = document.getElementById('lightbox-text');
  const author = document.getElementById('lightbox-author');
  const link = document.getElementById('lightbox-link');
  const embedContainer = document.getElementById('lightbox-embed');

  text.textContent = item.text || '';
  author.textContent = item.displayName ? `${item.displayName} @${item.username}` : '';
  link.href = `https://twitter.com/i/web/status/${item.id}`;
  embedContainer.innerHTML = '';

  if (item.imageKeys && item.imageKeys.length > 0) {
    for (const key of item.imageKeys) {
      const imgRecord = await dbGet('images', key);
      if (imgRecord) {
        const img = document.createElement('img');
        img.src = imgRecord.data;
        img.style.cssText = 'width:100%;border-radius:10px;display:block;margin-bottom:8px;';
        embedContainer.appendChild(img);
      }
    }
  }

  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-embed').innerHTML = '';
  currentItem = null;
}

async function deleteLike(id) {
  const like = await dbGet('likes', id);
  if (like && like.imageKeys) {
    for (const key of like.imageKeys) {
      await dbDelete('images', key);
    }
  }
  await dbDelete('likes', id);
  await dbPut('deleted', { id });
  closeLightbox();
  if (currentTab === 'general') {
    renderGallery(document.getElementById('search').value);
  } else if (currentBoard) {
    renderBoardGallery(currentBoard, document.getElementById('search').value);
  }
}

async function openBoardPicker() {
  const picker = document.getElementById('board-picker');
  const list = document.getElementById('board-picker-list');
  list.innerHTML = '';

  const boards = await dbGetAll('boards');

  if (boards.length === 0) {
    list.innerHTML = '<p style="color:#666;font-size:13px;">No boards yet. Create one below.</p>';
  } else {
    for (const board of boards) {
      const btn = document.createElement('button');
      btn.className = 'board-picker-item';
      btn.textContent = board.id;
      btn.onclick = () => assignToBoard(board.id);
      list.appendChild(btn);
    }
  }

  picker.classList.remove('hidden');
}

async function assignToBoard(boardName) {
  if (!currentItem) return;

  await dbPut('boards', { id: boardName });

  const like = await dbGet('likes', currentItem.id);
  if (like) {
    like.board = boardName;
    await dbPut('likes', like);
  }

  document.getElementById('board-picker').classList.add('hidden');
  closeLightbox();

  if (currentTab === 'general') {
    renderGallery(document.getElementById('search').value);
  } else if (currentBoard) {
    renderBoardGallery(currentBoard, document.getElementById('search').value);
  }
}

async function createNewBoard() {
  const input = document.getElementById('new-board-name');
  const name = input.value.trim();
  if (!name) return;
  input.value = '';
  await assignToBoard(name);
}

document.getElementById('file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (files.length > 0) importFiles(files);
});

document.getElementById('search').addEventListener('input', e => {
  if (currentTab === 'general') {
    renderGallery(e.target.value);
  } else if (currentBoard) {
    renderBoardGallery(currentBoard, e.target.value);
  }
});

document.getElementById('tab-general').addEventListener('click', () => {
  currentTab = 'general';
  currentBoard = null;
  document.getElementById('tab-general').classList.add('active');
  document.getElementById('tab-boards').classList.remove('active');
  document.getElementById('general-view').classList.remove('hidden');
  document.getElementById('boards-view').classList.add('hidden');
  renderGallery(document.getElementById('search').value);
});

document.getElementById('tab-boards').addEventListener('click', () => {
  currentTab = 'boards';
  currentBoard = null;
  document.getElementById('tab-boards').classList.add('active');
  document.getElementById('tab-general').classList.remove('active');
  document.getElementById('boards-view').classList.remove('hidden');
  document.getElementById('general-view').classList.add('hidden');
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('boards-list').classList.remove('hidden');
  renderBoards();
});

document.getElementById('back-btn').addEventListener('click', () => {
  currentBoard = null;
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('boards-list').classList.remove('hidden');
  renderBoards();
});

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-overlay').addEventListener('click', closeLightbox);
document.getElementById('lightbox-delete').addEventListener('click', () => {
  if (currentItem) deleteLike(currentItem.id);
});
document.getElementById('lightbox-board-btn').addEventListener('click', openBoardPicker);
document.getElementById('board-picker-overlay').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});
document.getElementById('board-picker-cancel').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});
document.getElementById('new-board-btn').addEventListener('click', createNewBoard);

document.querySelectorAll('.col-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentCols = parseInt(btn.dataset.cols);
    document.querySelectorAll('.col-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const gallery = document.getElementById('gallery');
    const boardGallery = document.getElementById('board-gallery');
    gallery.setAttribute('data-cols', currentCols);
    boardGallery.setAttribute('data-cols', currentCols);
    updateGalleryColumns();
  });
});

function updateGalleryColumns() {
  const gallery = document.getElementById('gallery');
  const boardGallery = document.getElementById('board-gallery');
  gallery.style.columnCount = currentCols;
  boardGallery.style.columnCount = currentCols;
}

openDB().then(database => {
  db = database;
  renderGallery();
  closeLightbox();
  document.getElementById('board-picker').classList.add('hidden');
});
