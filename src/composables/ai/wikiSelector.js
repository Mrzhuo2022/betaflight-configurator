import manifest from "@docs/ai-wiki/manifest.json";

/**
 * Select relevant Betaflight wiki docs based on the user's question and FC context.
 *
 * The manifest maps each doc to keywords (EN + CN) and a base priority. We score docs by
 * counting keyword hits in the haystack (user question + FC summary + blackbox digest type),
 * then inject the top 1-3 docs whose score > 0. This keeps token cost low (only relevant
 * docs go into the prompt) while giving the model authoritative, version-specific knowledge
 * it might not remember precisely.
 *
 * Docs live under docs/ai-wiki/ and are imported via Vite's ?raw suffix for the text content.
 * Only the selected docs are actually imported, so unused docs don't bloat the bundle —
 * Vite tree-shakes the dynamic imports.
 */

// Lazily-loaded raw markdown imports so only selected docs enter the bundle.
const rawImports = {
    "PID-Tuning-Guide.md": () => import("@docs/ai-wiki/PID-Tuning-Guide.md?raw"),
    "Freestyle-Tuning-Principles.md": () => import("@docs/ai-wiki/Freestyle-Tuning-Principles.md?raw"),
    "Dynamic-D.md": () => import("@docs/ai-wiki/Dynamic-D.md?raw"),
    "Feed-Forward-2-0.md": () => import("@docs/ai-wiki/Feed-Forward-2-0.md?raw"),
    "Dynamic-Idle.md": () => import("@docs/ai-wiki/Dynamic-Idle.md?raw"),
    "DSHOT-RPM-Filtering.md": () => import("@docs/ai-wiki/DSHOT-RPM-Filtering.md?raw"),
    "I-Term-Relax-Explained.md": () => import("@docs/ai-wiki/I-Term-Relax-Explained.md?raw"),
    "Black-Box-logging-and-usage.md": () => import("@docs/ai-wiki/Black-Box-logging-and-usage.md?raw"),
    "BBE-Power-Spectral-Density-charts.md": () => import("@docs/ai-wiki/BBE-Power-Spectral-Density-charts.md?raw"),
    "Soft-Mounting-and-Noise-Reduction.md": () => import("@docs/ai-wiki/Soft-Mounting-and-Noise-Reduction.md?raw"),
    "Crash-Recovery.md": () => import("@docs/ai-wiki/Crash-Recovery.md?raw"),
    "Deep-Dive.md": () => import("@docs/ai-wiki/Deep-Dive.md?raw"),
};

const MAX_DOCS = 3;
const MAX_CHARS_PER_DOC = 8000; // cap each doc so the total injection stays token-friendly

/**
 * Score each wiki doc by keyword hits against the haystack.
 * @param {string} haystack  lowercase user question + context keywords
 * @returns {Array<{file: string, title: string, score: number}>}  sorted desc by score
 */
function scoreDocs(haystack) {
    const h = (haystack || "").toLowerCase();
    const scored = [];
    for (const doc of manifest.documents) {
        let score = 0;
        for (const kw of doc.keywords) {
            const k = kw.toLowerCase().trim();
            if (!k) continue;
            if (h.includes(k)) {
                // Longer keyword matches are more specific → weight by length.
                score += Math.max(1, Math.floor(k.length / 4));
            }
        }
        if (score > 0) {
            scored.push({ file: doc.file, title: doc.title, score: score + (doc.priority || 0) });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/**
 * Select and load the top wiki docs relevant to the user's question.
 *
 * @param {string} userQuestion   the user's free-form question
 * @param {string} [extraContext]  optional FC summary / blackbox digest type to enrich matching
 * @returns {Promise<Array<{title: string, content: string}>>}  selected docs (0-3)
 */
export async function selectWikiDocs(userQuestion, extraContext = "") {
    const haystack = `${userQuestion || ""}\n${extraContext || ""}`;
    const ranked = scoreDocs(haystack);
    const selected = ranked.slice(0, MAX_DOCS);
    if (selected.length === 0) return [];

    const results = [];
    for (const { file, title } of selected) {
        const loader = rawImports[file];
        if (!loader) continue;
        try {
            const mod = await loader();
            const raw = typeof mod.default === "string" ? mod.default : String(mod.default || "");
            results.push({
                title,
                content: raw.slice(0, MAX_CHARS_PER_DOC),
            });
        } catch {
            // Doc failed to load (bundle issue) — skip silently rather than breaking the chat.
        }
    }
    return results;
}

/**
 * Format selected wiki docs into a system-message string for the AI prompt.
 * @param {Array<{title: string, content: string}>} docs
 * @returns {string}
 */
export function formatWikiContext(docs) {
    if (!docs || docs.length === 0) return "";
    const sections = docs.map((d) => `### ${d.title}\n${d.content}`);
    return [
        "## Official Betaflight Wiki Reference (selected for this question)",
        "Use this authoritative documentation to ground your advice. Cite specific parameter",
        "names, ranges, and troubleshooting steps from these docs where relevant.",
        "",
        sections.join("\n\n---\n\n"),
    ].join("\n");
}
