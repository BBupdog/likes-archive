const DB_NAME = 'likesArchive';
const DB_VERSION = 2;
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

function extractImageUrl(text) {
  if (!text) return null;
  const tcoLinks = text.match(/https:\/\/t\.co\/\S+/g);
  if (!tcoLinks) return null;
  return tcoLinks[tcoLinks.length - 1];
}

async function importFiles(files) {
  const deletedAll = await dbGetAll('deleted');
  const deletedIds = new Set(deletedAll.map(d => d.id));

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await file.text();
    let json;

    try {
      const cleaned = text
        .replace(/^window\.YTD\.like\.part\d+\s*=\s*/, '')
        .replace(/^window\.YTD\.bookmark\.part\d+\s*=\s*/, '')
        .trim();
      json = JSON.parse(cleaned);
    } catch {
      alert(`Could not read ${file.name}. Skipping it.`);
      continue;
    }

    for (const entry of json) {
      const item = entry.like || entry.bookmark;
      if (!item) continue;

      const id = item.tweetId;
      if (!id) continue;

      if (deletedIds.has(id)) {
        skipped++;
        continue;
      }

      const existing = await dbGet('likes', id);
      if (existing) {
        skipped++;
        continue;
      }

      const fullText = item.fullText || '';
      const imgUrl = extractImageUrl(fullText);

      await dbPut('likes', {
        id,
        text: fullText,
        imgUrl,
        board: null,
        date: Date.now()
      });

      imported++;
    }
  }

  alert(`Done. ${imported} new likes imported, ${skipped} skipped.`);
  renderGallery();
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;

  if (item.text) {
    const p = document.createElement('div');
    p.className = 'card-text';
    p.textContent = item.text.slice(0, 140) + (item.text.length > 140 ? '...' : '');
    card.appendChild(p);
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
    item.text.toLowerCase().includes(filter.toLowerCase())
  );

  updateCounter(filtered.length);

  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes yet. Tap Import to get started.</p>';
    return;
  }

  for (const item of filtered) {
    gallery.appendChild(createCard(item));
  }
}

async function renderBoardGallery(boardName, filter = '') {
  const gallery = document.getElementById('board-gallery');
  gallery.innerHTML = '';

  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    item.board === boardName &&
    item.text.toLowerCase().includes(filter.toLowerCase())
  );

  updateCounter(filtered.length);

  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes in this board yet.</p>';
    return;
  }

  for (const item of filtered) {
    gallery.appendChild(createCard(item));
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
      if (confirm(`Delete board "${board.id}"? Likes inside will not be deleted, just unassigned.`)) {
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

function openLightbox(item) {
  currentItem = item;

  const link = document.getElementById('lightbox-link');
  const embedContainer = document.getElementById('lightbox-embed');

  link.href = `https://twitter.com/i/web/status/${item.id}`;

  embedContainer.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.src = `https://platform.twitter.com/embed/Tweet.html?id=${item.id}&theme=dark&chrome=nofooter&dnt=true`;
  iframe.style.cssText = 'width:100%;height:550px;border:none;border-radius:12px;display:block;';
  iframe.allow = 'encrypted-media';
  embedContainer.appendChild(iframe);

  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-embed').innerHTML = '';
  currentItem = null;
}

async function deleteLike(id) {
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
    document.getElementById('gallery').className = currentCols === 2 ? '' : `cols-${currentCols}`;
    document.getElementById('board-gallery').className = currentCols === 2 ? '' : `cols-${currentCols}`;
  });
});

openDB().then(database => {
  db = database;
  renderGallery();
  closeLightbox();
  document.getElementById('board-picker').classList.add('hidden');
});
