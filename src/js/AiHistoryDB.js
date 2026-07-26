/**
 * IndexedDB-backed storage for complete AI conversation history.
 *
 * localStorage is inappropriate here: it is synchronous, shared with all app settings and
 * usually capped near 5 MB. IndexedDB stores the full conversation (answer, reasoning and
 * diagnosis objects) without application-level truncation.
 */

const DB_NAME = "betaflight-ai";
const DB_VERSION = 1;
const STORE = "messages";

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("IndexedDB is unavailable."));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    });
}

/**
 * Convert Vue proxies and other structured-clone-hostile values into plain JSON data.
 * Conversation records are JSON-shaped, so this preserves all user-visible content while
 * avoiding DataCloneError when suggestion objects are reactive proxies.
 */
function toPlainRecord(message) {
    return JSON.parse(
        JSON.stringify({
            role: message.role,
            content: message.content || "",
            suggestion: message.suggestion || null,
            reasoning: message.reasoning || "",
            ts: message.ts || Date.now(),
        }),
    );
}

/** Load the complete history, oldest first. */
export async function loadHistory() {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE, "readonly");
        const records = await requestToPromise(transaction.objectStore(STORE).getAll());
        await transactionToPromise(transaction);
        return (Array.isArray(records) ? records : []).map(({ id: _id, ...message }) => message);
    } catch (error) {
        console.error("AI history load failed:", error);
        return [];
    }
}

/**
 * Replace IndexedDB history with the complete in-memory conversation. No message-count,
 * content-length or reasoning-length cap is applied.
 */
export async function saveHistory(messages) {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        store.clear();
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
            store.add(toPlainRecord(message));
        }
        await transactionToPromise(transaction);
        return true;
    } catch (error) {
        console.error("AI history save failed:", error);
        return false;
    }
}

/** Clear all stored conversation records. */
export async function clearHistory() {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).clear();
        await transactionToPromise(transaction);
        return true;
    } catch (error) {
        console.error("AI history clear failed:", error);
        return false;
    }
}
