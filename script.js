const DB_NAME = 'likesArchive';
const DB_VERSION = 1;
let db;

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

async function downloadImage(url, id) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function importLikes(file) {
  const text = await file.text();
  let json;

  try {
    const cleaned = text.replace(/^window\.YTD\.like\.part0\s*=\s*/, '');
    json = JSON.parse(cleaned);
  } catch {
    alert('Could not read the file. Make sure you selected the correct file from your Twitter export.');
    return;
  }

  const deletedAll = await dbGetAll('deleted');
  const deletedIds = new Set(deletedAll.map(d => d.id));

  let imported = 0;
  let skipped = 0;

  for (const entry of json) {
    const like = entry.like;
    const id = like.tweetId;

    if (deletedIds.has(id)) {
      skipped++;
      continue;
    }

    const existing = await dbGet('likes', id);
    if (existing) {
      skipped++;
      continue;
    }

    const urls = like.expandedUrl ? [like.expandedUrl] : [];
    const imgUrl = urls.find(u => u.match(/\.(jpg|jpeg|png|gif|webp)/i)) || null;

    let imageData = null;
    if (imgUrl) {
      imageData = await downloadImage(imgUrl, id);
    }

    if (imageData) {
      await dbPut('images', { id, data: imageData });
    }

    await dbPut('likes', {
      id,
      text: like.fullText || '',
      author: like.expandedUrl || '',
      imgUrl: imgUrl || null,
      hasImage: !!imageData,
      date: Date.now()
    });

    imported++;
  }

  alert(`Done. ${imported} new likes imported, ${skipped} skipped.`);
  renderGallery();
}

async function renderGallery(filter = '') {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = '';

  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    item.text.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes yet. Tap "Import Likes" to get started.</p>';
    return;
  }

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;

    if (item.hasImage) {
      const imgRecord = await dbGet('images', item.id);
      if (imgRecord) {
        const img = document.createElement('img');
        img.src = imgRecord.data;
        img.alt = item.text.slice(0, 60);
        img.loading = 'lazy';
        card.appendChild(img);
      }
    }

    if (item.text) {
      const p = document.createElement('div');
      p.className = 'card-text';
      p.textContent = item.text.slice(0, 120) + (item.text.length > 120 ? '...' : '');
      card.appendChild(p);
    }

    card.addEventListener('click', () => openLightbox(item));
    gallery.appendChild(card);
  }
}

async function openLightbox(item) {
  const lightbox = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const text = document.getElementById('lightbox-text');
  const link = document.getElementById('lightbox-link');

  if (item.hasImage) {
    const imgRecord = await dbGet('images', item.id);
    if (imgRecord) {
      img.src = imgRecord.data;
      img.style.display = 'block';
    }
  } else {
    img.style.display = 'none';
  }

  text.textContent = item.text;
  link.href = `https://twitter.com/i/web/status/${item.id}`;

  document.getElementById('lightbox-delete').onclick = () => deleteLike(item.id);
  document.getElementById('lightbox-overlay').onclick = closeLightbox;

  lightbox.classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}

async function deleteLike(id) {
  await dbDelete('likes', id);
  await dbDelete('images', id);
  await dbPut('deleted', { id });
  closeLightbox();
  renderGallery();
}

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) importLikes(file);
});

document.getElementById('search').addEventListener('input', e => {
  renderGallery(e.target.value);
});

openDB().then(database => {
  db = database;
  renderGallery();
});
