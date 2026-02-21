
const DB_NAME = 'MudhakaraDB';
const STORE_NAME = 'Files';
const META_STORE = 'FileMeta';
const DB_VERSION = 2;

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
    };

    request.onblocked = () => {
      console.warn("⚠️ IndexedDB blocked: Please close other tabs of this app.");
      alert("يرجى إغلاق علامات التبويب الأخرى للتطبيق لضمان عمل قاعدة البيانات بشكل صحيح.");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveFile = async (id: string, content: string, name?: string): Promise<void> => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    const fileStore = transaction.objectStore(STORE_NAME);
    fileStore.put(content, id);

    if (name) {
      const metaStore = transaction.objectStore(META_STORE);
      metaStore.put({ id, name, contentLength: content.length, timestamp: Date.now() });
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getFile = async (id: string): Promise<string | null> => {
  const db = await openDB();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const res = request.result;
      if (typeof res === 'string') {
        resolve(res);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => reject(request.error);
  });
};

export const deleteFile = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.objectStore(META_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const findExactDuplicate = async (content: string): Promise<string | null> => {
  const db = await openDB();
  return new Promise<string | null>((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    
    request.onsuccess = (event: any) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value === content) {
          resolve(cursor.key as string);
          return;
        }
        cursor.continue();
      } else {
        resolve(null);
      }
    };
  });
};

export const findSimilarFile = async (name: string): Promise<string | null> => {
  const db = await openDB();
  return new Promise<string | null>((resolve) => {
    const transaction = db.transaction(META_STORE, 'readonly');
    const store = transaction.objectStore(META_STORE);
    const request = store.openCursor();
    
    request.onsuccess = (event: any) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.name === name) {
          resolve(cursor.key as string);
          return;
        }
        cursor.continue();
      } else {
        resolve(null);
      }
    };
  });
};
