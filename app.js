/* =================================================================
   MUSIC ENGLISH COACH — standalone PWA build
   Vanilla JS, no build step. Data lives in localStorage.
   AI calls go straight to the Anthropic API using a key you provide
   (stored only in this browser's localStorage).
================================================================= */

const DEFAULT_MODEL = "claude-sonnet-5";

const DEMO_SONG = {
  id: "demo-1",
  title: "Neon Hour",
  artist: "The Static Parade (exemplo)",
  level: "Intermediário",
  createdAt: Date.now(),
  verses: [
    "I've been carrying this weight since the summer let me down",
    "Every streetlight knows my name but forgets it by the dawn",
    "We used to chase the neon hour, wide awake and full of nerve",
    "Now I'm learning how to let it go, one quiet breath at a time",
  ],
  analyses: {},
};

/* ---------------- storage helpers ---------------- */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("storage error", key, e);
  }
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- SRS (SM-2 lite) ---------------- */
function reviewCard(card, rating) {
  let { ease = 2.3, interval = 0, reps = 0 } = card;
  if (rating === 1) {
    reps = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ease);
    const delta = 0.1 - (4 - rating) * (0.08 + (4 - rating) * 0.02);
    ease = Math.max(1.3, ease + delta);
  }
  const due = new Date();
  due.setDate(due.getDate() + interval);
  return { ...card, ease, interval, reps, dueDate: due.toISOString().slice(0, 10) };
}

/* ---------------- Anthropic API call ---------------- */
async function analyzeVerse(verseText, song, apiKey) {
  const prompt = `Você é um professor de inglês para brasileiros que aprendem através de letras de música.
Analise este verso e responda APENAS com um JSON válido (sem markdown, sem texto fora do JSON), exatamente neste formato:
{"literal":"...","natural":"...","grammar":"...","vocab":[{"word":"...","meaning":"...","example":"..."}]}

Regras:
- "literal": tradução literal, palavra por palavra, para mostrar a estrutura.
- "natural": tradução natural e idiomática em português do Brasil.
- "grammar": 1-2 frases explicando alguma estrutura gramatical relevante do verso (tempo verbal, phrasal verb, contração etc). Se não houver nada notável, use string vazia.
- "vocab": até 4 palavras ou expressões relevantes (evite artigos, pronomes e palavras muito básicas), cada uma com "word" (a palavra/expressão em inglês), "meaning" (significado em português) e "example" (frase de exemplo diferente do verso original).

Música: "${song.title}" - ${song.artist}
Verso: "${verseText}"`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API ${response.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("Resposta vazia da IA");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

/* ---------------- global state ---------------- */
const state = {
  tab: "library",
  songs: [],
  flashcards: [],
  stats: { streak: 0, lastActiveDate: null, wordsLearned: 0 },
  activeSongId: null,
  studyIndex: 0,
  showAddForm: false,
  showSettings: false,
  apiKey: localStorage.getItem("mec_api_key") || "",
  analyzing: false,
  analyzeError: null,
  addedFlashSet: new Set(),
  practiceSongId: null,
  practiceVerseIndex: null,
  practiceChecked: false,
  practiceValues: {},
  flashPos: 0,
  flashRevealed: false,
};

/* ---------------- init ---------------- */
function init() {
  const index = loadJSON("mec_songs_index", null);
  if (!index) {
    state.songs = [DEMO_SONG];
    saveJSON("mec_songs_index", [{ id: DEMO_SONG.id, title: DEMO_SONG.title, artist: DEMO_SONG.artist, level: DEMO_SONG.level }]);
    saveJSON(`mec_song_${DEMO_SONG.id}`, DEMO_SONG);
  } else {
    state.songs = index.map((s) => loadJSON(`mec_song_${s.id}`, null)).filter(Boolean);
  }
  state.flashcards = loadJSON("mec_flashcards", []);
  state.stats = loadJSON("mec_stats", { streak: 0, lastActiveDate: null, wordsLearned: 0 });
  markActiveToday();
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function markActiveToday() {
  const today = todayStr();
  if (state.stats.lastActiveDate === today) return;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const nextStreak = state.stats.lastActiveDate === yStr ? (state.stats.streak || 0) + 1 : 1;
  state.stats = { ...state.stats, streak: nextStreak, lastActiveDate: today };
  saveJSON("mec_stats", state.stats);
}

function persistSong(song) {
  const exists = state.songs.some((s) => s.id === song.id);
  state.songs = exists ? state.songs.map((s) => (s.id === song.id ? song : s)) : [...state.songs, song];
  saveJSON("mec_songs_index", state.songs.map(({ id, title, artist, level }) => ({ id, title, artist, level })));
  saveJSON(`mec_song_${song.id}`, song);
}

function deleteSongById(id) {
  state.songs = state.songs.filter((s) => s.id !== id);
  saveJSON("mec_songs_index", state.songs.map(({ id, title, artist, level }) => ({ id, title, artist, level })));
  localStorage.removeItem(`mec_song_${id}`);
}

function addFlashcards(newCards) {
  const existingWords = new Set(state.flashcards.map((c) => c.word.toLowerCase()));
  const filtered = newCards.filter((c) => !existingWords.has(c.word.toLowerCase()));
  state.flashcards = [...state.flashcards, ...filtered];
  saveJSON("mec_flashcards", state.flashcards);
  if (filtered.length) {
    state.stats = { ...state.stats, wordsLearned: (state.stats.wordsLearned || 0) + filtered.length };
    saveJSON("mec_stats", state.stats);
  }
}

function updateFlashcardById(updated) {
  state.flashcards = state.flashcards.map((c) => (c.id === updated.id ? updated : c));
  saveJSON("mec_flashcards", state.flashcards);
}

function dueCount() {
  return state.flashcards.filter((c) => !c.dueDate || c.dueDate <= todayStr()).length;
}

/* ---------------- render dispatcher ---------------- */
function render() {
  const app = document.getElementById("app");
  app.innerHTML = `
    ${renderHeader()}
    ${renderNavTabs()}
    <div class="mt-24">${renderTabBody()}</div>
    ${state.showSettings ? renderSettingsModal() : ""}
  `;
}

function renderTabBody() {
  switch (state.tab) {
    case "library": return renderLibrary();
    case "study": return renderStudy();
    case "practice": return renderPractice();
    case "flashcards": return renderFlashcards();
    case "stats": return renderStats();
    default: return "";
  }
}

/* ---------------- header + nav ---------------- */
function tapeCounter(value, label) {
  const digits = String(value).padStart(4, "0").split("");
  return `
    <div class="tape-counter">
      <div class="tape-digits">${digits.map((d) => `<span>${d}</span>`).join("")}</div>
      <span class="tape-label">${label}</span>
    </div>`;
}

function renderHeader() {
  const due = dueCount();
  return `
    <div class="header-row">
      <div>
        <div class="brand">
          <span style="color:var(--gold)">♪</span>
          <h1>Music English Coach</h1>
        </div>
        <p class="tagline">Aprenda inglês através das músicas que você já ama</p>
      </div>
      <div class="header-stats">
        ${tapeCounter(state.stats.streak || 0, "Sequência")}
        ${tapeCounter(state.stats.wordsLearned || 0, "Palavras")}
        ${due > 0 ? `<span class="pill pill-coral">${due} para revisar</span>` : ""}
        <button class="settings-link" data-action="open-settings">Configurar API</button>
      </div>
    </div>`;
}

function renderNavTabs() {
  const items = [
    { id: "library", label: "Biblioteca" },
    { id: "study", label: "Estudo" },
    { id: "practice", label: "Prática" },
    { id: "flashcards", label: "Flashcards", badge: dueCount() },
    { id: "stats", label: "Estatísticas" },
  ];
  return `
    <div class="nav-tabs">
      ${items.map((it) => `
        <button class="nav-tab ${state.tab === it.id ? "active" : ""}" data-action="switch-tab" data-tab="${it.id}">
          ${it.label}
          ${it.badge > 0 ? `<span class="nav-badge">${it.badge}</span>` : ""}
        </button>
      `).join("")}
    </div>`;
}

/* ---------------- settings modal ---------------- */
function renderSettingsModal() {
  return `
    <div class="modal-backdrop" data-action="close-settings-backdrop">
      <div class="modal-box">
        <div class="flex-between">
          <span style="font-family:var(--display-font);font-size:18px;">Chave da API Anthropic</span>
          <button data-action="close-settings" class="btn btn-ghost" style="padding:4px 8px;">✕</button>
        </div>
        <p class="muted small mt-8">
          O app usa a Claude API para analisar os versos. Crie uma chave em
          <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>
          e cole abaixo. Ela fica salva apenas neste navegador (localStorage) — nunca é enviada a nenhum servidor além da própria Anthropic.
        </p>
        <input id="api-key-input" class="field-input mt-12" type="password" placeholder="sk-ant-..." value="${escapeHtml(state.apiKey)}" />
        <div class="mt-16 flex-gap">
          <button class="btn btn-primary" data-action="save-api-key">Salvar</button>
        </div>
        <div class="mt-24" style="border-top:1px solid var(--border);padding-top:16px;">
          <span class="label-eyebrow">Backup dos dados</span>
          <p class="muted small mt-8">Exporte suas músicas, flashcards e progresso para um arquivo, ou importe um backup salvo antes.</p>
          <div class="flex-gap mt-12">
            <button class="btn btn-subtle" data-action="export-data">Exportar backup</button>
            <label class="btn btn-subtle" style="cursor:pointer;">
              Importar backup
              <input type="file" accept="application/json" id="import-file-input" style="display:none" data-action="import-data" />
            </label>
          </div>
        </div>
      </div>
    </div>`;
}

/* ---------------- library ---------------- */
function renderLibrary() {
  return `
    <div class="flex-between">
      <h2 style="font-family:var(--display-font);font-size:20px;">Sua biblioteca</h2>
      <button class="btn btn-primary" data-action="toggle-add-form">${state.showAddForm ? "Cancelar" : "+ Adicionar música"}</button>
    </div>
    ${state.showAddForm ? renderAddSongForm() : ""}
    <div class="mt-16">
      ${state.songs.length === 0 ? `<div class="empty-state">Sua biblioteca está vazia. Adicione uma música para começar.</div>` : ""}
      ${state.songs.map(renderSongRow).join("")}
    </div>`;
}

function renderSongRow(s) {
  const analyzed = Object.keys(s.analyses || {}).length;
  return `
    <div class="song-row">
      <div style="cursor:pointer;flex:1;" data-action="open-song" data-id="${s.id}">
        <div class="song-title-line">
          <span style="font-weight:700;font-size:15px;">${escapeHtml(s.title)}</span>
          <span class="pill pill-teal">${escapeHtml(s.level)}</span>
        </div>
        <div class="song-meta">${escapeHtml(s.artist)}</div>
        <div class="song-progress">${s.verses.length} versos · ${analyzed} analisados</div>
      </div>
      <div class="flex-gap">
        <button class="btn btn-ghost" data-action="open-song" data-id="${s.id}">Estudar →</button>
        ${s.id !== "demo-1" ? `<button class="btn btn-ghost" data-action="delete-song" data-id="${s.id}" title="Remover">🗑</button>` : ""}
      </div>
    </div>`;
}

function renderAddSongForm() {
  return `
    <div class="card card-tight mt-16">
      <p class="muted small">Cole a letra de uma música à qual você já tem acesso legítimo (do seu player, encarte, etc). Uma linha = um verso.</p>
      <div class="form-grid-2 mt-12">
        <input id="new-song-title" class="field-input" placeholder="Título da música" />
        <input id="new-song-artist" class="field-input" placeholder="Artista" />
      </div>
      <select id="new-song-level" class="field-select mt-12">
        <option>Iniciante</option>
        <option selected>Intermediário</option>
        <option>Avançado</option>
      </select>
      <textarea id="new-song-lyrics" class="field-textarea mt-12" placeholder="Cole a letra aqui, um verso por linha..."></textarea>
      <div class="mt-12">
        <button class="btn btn-primary" data-action="submit-add-form">Salvar na biblioteca</button>
      </div>
    </div>`;
}

/* ---------------- study ---------------- */
function renderStudy() {
  const song = state.songs.find((s) => s.id === state.activeSongId);
  if (!song) {
    if (state.songs.length === 0) {
      return `<div class="empty-state">Nenhuma música na biblioteca ainda.</div>
        <div class="mt-12"><button class="btn btn-primary" data-action="switch-tab" data-tab="library">Ir para a biblioteca</button></div>`;
    }
    return `
      <p class="muted mt-8">Escolha uma música da sua biblioteca para estudar:</p>
      <div class="mt-12">
        ${state.songs.map((s) => `
          <button class="song-row" style="width:100%;text-align:left;cursor:pointer;" data-action="pick-study-song" data-id="${s.id}">
            <span style="font-weight:700;">${escapeHtml(s.title)}</span>
            <span class="muted small"> — ${escapeHtml(s.artist)}</span>
          </button>
        `).join("")}
      </div>`;
  }

  const index = state.studyIndex;
  const verse = song.verses[index];
  const analysis = song.analyses?.[index];

  return `
    <button class="settings-link" data-action="back-to-library" style="margin-bottom:12px;">← Voltar à biblioteca</button>
    <div class="flex-between">
      <div>
        <h2 style="font-family:var(--display-font);font-size:20px;">${escapeHtml(song.title)}</h2>
        <p class="muted small">${escapeHtml(song.artist)}</p>
      </div>
      <span class="pill pill-gold">Verso ${index + 1} / ${song.verses.length}</span>
    </div>

    <div class="card mt-16">
      <p class="verse-text">${escapeHtml(verse)}</p>

      ${!analysis && !state.analyzing ? `
        <div class="mt-16">
          <button class="btn btn-primary" data-action="analyze-verse">✨ Analisar este verso</button>
          ${state.analyzeError ? `<p style="color:var(--coral);font-size:13px;margin-top:8px;">${escapeHtml(state.analyzeError)}</p>` : ""}
        </div>` : ""}

      ${state.analyzing ? `<div class="flex-gap muted mt-16"><span class="spinner"></span> Analisando com IA...</div>` : ""}

      ${analysis ? renderAnalysisBlock(analysis, index, song) : ""}
    </div>

    <div class="flex-between mt-16">
      <button class="btn btn-ghost" data-action="prev-verse" ${index === 0 ? "disabled" : ""}>← Anterior</button>
      <button class="btn btn-ghost" data-action="next-verse" ${index === song.verses.length - 1 ? "disabled" : ""}>Próximo verso →</button>
    </div>`;
}

function renderAnalysisBlock(analysis, index, song) {
  const added = state.addedFlashSet.has(`${song.id}:${index}`);
  return `
    <div class="mt-20">
      <span class="label-eyebrow">Tradução literal</span>
      <p class="muted learn-text mt-8">${escapeHtml(analysis.literal || "")}</p>
    </div>
    <div class="mt-16">
      <span class="label-eyebrow">Tradução natural</span>
      <p class="learn-text mt-8">${escapeHtml(analysis.natural || "")}</p>
    </div>
    ${analysis.grammar ? `
      <div class="mt-16">
        <span class="label-eyebrow">Gramática</span>
        <p class="learn-text mt-8" style="color:var(--teal);">${escapeHtml(analysis.grammar)}</p>
      </div>` : ""}
    ${analysis.vocab?.length ? `
      <div class="mt-16">
        <span class="label-eyebrow">Palavras-chave</span>
        <div class="mt-8">
          ${analysis.vocab.map((v) => `
            <div class="vocab-item">
              <span class="vocab-word learn-text">${escapeHtml(v.word)}</span>
              <span class="vocab-meaning learn-text"> — ${escapeHtml(v.meaning)}</span>
              <div class="vocab-example learn-text">${escapeHtml(v.example)}</div>
            </div>
          `).join("")}
        </div>
        <div class="mt-8">
          ${added
            ? `<span class="pill pill-teal">✓ Adicionado aos flashcards</span>`
            : `<button class="btn btn-subtle" data-action="add-flashcards" data-index="${index}">+ Adicionar ao flashcards</button>`}
        </div>
      </div>` : ""}
    `;
}

/* ---------------- practice (cloze) ---------------- */
function buildCloze(text, words) {
  if (!text) return { display: [], blanks: [] };
  const tokens = text.split(/(\s+)/);
  const blanks = [];
  const display = tokens.map((tok, i) => {
    const clean = tok.replace(/[.,!?;:'"]/g, "").toLowerCase();
    if (words.includes(clean)) {
      blanks.push({ i, answer: clean });
      return { blank: true, i };
    }
    return { blank: false, text: tok };
  });
  return { display, blanks };
}

function renderPractice() {
  const eligible = state.songs.filter((s) => Object.keys(s.analyses || {}).length > 0);
  if (eligible.length === 0) {
    return `<div class="empty-state">Analise ao menos um verso na aba Estudo para liberar exercícios de prática.</div>`;
  }
  if (!state.practiceSongId || !eligible.some((s) => s.id === state.practiceSongId)) {
    state.practiceSongId = eligible[0].id;
  }
  const song = eligible.find((s) => s.id === state.practiceSongId);
  const analyzedIndices = Object.keys(song.analyses).map(Number);
  if (state.practiceVerseIndex === null || !analyzedIndices.includes(state.practiceVerseIndex)) {
    state.practiceVerseIndex = analyzedIndices[0];
  }
  const vIdx = state.practiceVerseIndex;
  const verse = song.verses[vIdx];
  const analysis = song.analyses[vIdx];
  const vocabWords = (analysis?.vocab || []).map((v) => v.word.toLowerCase());
  const { display, blanks } = buildCloze(verse, vocabWords);

  let clozeBody;
  if (blanks.length === 0) {
    clozeBody = `<div class="empty-state">Este verso não tem palavras-chave suficientes para um exercício. Escolha outro verso.</div>`;
  } else {
    const inputsHtml = display.map((tok) => {
      if (!tok.blank) return escapeHtml(tok.text);
      const blankInfo = blanks.find((b) => b.i === tok.i);
      const val = state.practiceValues[tok.i] || "";
      let cls = "cloze-input";
      if (state.practiceChecked) {
        cls += val.trim().toLowerCase() === blankInfo.answer ? " correct" : " incorrect";
      }
      const width = Math.max(60, blankInfo.answer.length * 11);
      return `<input class="${cls}" style="width:${width}px" data-blank-index="${tok.i}" value="${escapeHtml(val)}" ${state.practiceChecked ? "disabled" : ""} />`;
    }).join("");

    const correctCount = blanks.filter((b) => (state.practiceValues[b.i] || "").trim().toLowerCase() === b.answer).length;

    clozeBody = `
      <div class="card">
        <p class="cloze-text">${inputsHtml}</p>
        <div class="mt-20">
          ${!state.practiceChecked
            ? `<button class="btn btn-primary" data-action="check-cloze">✓ Conferir</button>`
            : `<div class="flex-gap">
                <span class="pill ${correctCount === blanks.length ? "pill-teal" : "pill-coral"}">${correctCount} / ${blanks.length} corretas</span>
                <button class="btn btn-ghost" data-action="retry-cloze">↺ Tentar de novo</button>
              </div>`}
        </div>
      </div>`;
  }

  return `
    <div class="flex-gap" style="flex-wrap:wrap;margin-bottom:16px;">
      <select class="field-select" style="width:auto;" data-action="practice-select-song">
        ${eligible.map((s) => `<option value="${s.id}" ${s.id === song.id ? "selected" : ""}>${escapeHtml(s.title)}</option>`).join("")}
      </select>
      ${analyzedIndices.length > 1 ? `
        <select class="field-select" style="width:auto;" data-action="practice-select-verse">
          ${analyzedIndices.map((i) => `<option value="${i}" ${i === vIdx ? "selected" : ""}>Verso ${i + 1}</option>`).join("")}
        </select>` : ""}
    </div>
    ${clozeBody}`;
}

/* ---------------- flashcards review ---------------- */
function renderFlashcards() {
  const due = state.flashcards.filter((c) => !c.dueDate || c.dueDate <= todayStr());
  if (state.flashcards.length === 0) {
    return `<div class="empty-state">Você ainda não tem flashcards. Analise versos na aba Estudo e adicione palavras.</div>`;
  }
  if (due.length === 0) {
    return `<div class="empty-state">Nenhuma revisão pendente hoje. Você tem ${state.flashcards.length} palavras no total — volte amanhã!</div>`;
  }
  if (state.flashPos >= due.length) {
    return `
      <div style="text-align:center;padding:40px;">
        <p style="font-family:var(--display-font);font-size:22px;margin-bottom:8px;">Revisão concluída 🎉</p>
        <p class="muted">Volte amanhã para a próxima leva.</p>
      </div>`;
  }
  const current = due[state.flashPos];
  return `
    <div style="max-width:480px;margin:0 auto;">
      <p class="muted small" style="text-align:center;margin-bottom:12px;">${state.flashPos + 1} / ${due.length}</p>
      <div class="flash-card" data-action="reveal-flashcard">
        <p class="flash-word">${escapeHtml(current.word)}</p>
        <p class="flash-song">${escapeHtml(current.songTitle)}</p>
        ${!state.flashRevealed
          ? `<p class="muted small mt-20">Toque para revelar</p>`
          : `<div class="mt-16">
              <p class="flash-meaning">${escapeHtml(current.meaning)}</p>
              <p class="flash-example">${escapeHtml(current.example)}</p>
            </div>`}
      </div>
      ${state.flashRevealed ? `
        <div class="rate-row">
          <button class="btn btn-danger" data-action="rate-flashcard" data-rating="1">Errei</button>
          <button class="btn btn-subtle" data-action="rate-flashcard" data-rating="2">Difícil</button>
          <button class="btn btn-subtle" data-action="rate-flashcard" data-rating="3">Bom</button>
          <button class="btn btn-primary" data-action="rate-flashcard" data-rating="4">Fácil</button>
        </div>` : ""}
    </div>`;
}

/* ---------------- stats ---------------- */
function renderStats() {
  const totalVerses = state.songs.reduce((sum, s) => sum + s.verses.length, 0);
  const analyzedVerses = state.songs.reduce((sum, s) => sum + Object.keys(s.analyses || {}).length, 0);
  const masteredCards = state.flashcards.filter((c) => c.reps >= 3).length;

  const cards = [
    { label: "Sequência atual", value: `${state.stats.streak || 0} dias` },
    { label: "Palavras no dicionário", value: state.flashcards.length },
    { label: "Palavras dominadas", value: masteredCards },
    { label: "Versos analisados", value: `${analyzedVerses} / ${totalVerses}` },
    { label: "Músicas na biblioteca", value: state.songs.length },
  ];

  return `
    <h2 style="font-family:var(--display-font);font-size:20px;margin-bottom:16px;">Suas estatísticas</h2>
    <div class="stat-grid">
      ${cards.map((c) => `
        <div class="stat-card">
          <p class="stat-value" style="color:var(--gold);">${c.value}</p>
          <p class="stat-label">${c.label}</p>
        </div>
      `).join("")}
    </div>
    ${state.songs.length > 0 ? `
      <div class="mt-24">
        <span class="label-eyebrow">Progresso por música</span>
        <div class="mt-8">
          ${state.songs.map((s) => {
            const done = Object.keys(s.analyses || {}).length;
            const pct = Math.round((done / s.verses.length) * 100);
            return `
              <div class="progress-row">
                <div class="flex-between small"><span>${escapeHtml(s.title)}</span><span class="muted">${pct}%</span></div>
                <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
              </div>`;
          }).join("")}
        </div>
      </div>` : ""}`;
}

/* ---------------- utils ---------------- */
function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- event delegation ---------------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case "switch-tab":
      state.tab = el.dataset.tab;
      state.activeSongId = null;
      state.analyzeError = null;
      render();
      break;

    case "open-settings":
      state.showSettings = true;
      render();
      break;
    case "close-settings":
      state.showSettings = false;
      render();
      break;
    case "close-settings-backdrop":
      // Only close when the click landed on the backdrop itself, not on
      // something inside the modal box that happened to bubble up to it.
      if (e.target === el) {
        state.showSettings = false;
        render();
      }
      break;

    case "save-api-key": {
      const input = document.getElementById("api-key-input");
      state.apiKey = input.value.trim();
      localStorage.setItem("mec_api_key", state.apiKey);
      state.showSettings = false;
      render();
      break;
    }

    case "export-data": {
      const backup = {
        songs: state.songs,
        flashcards: state.flashcards,
        stats: state.stats,
        exportedAt: new Date().toISOString(),
      };
      downloadFile(`music-english-coach-backup-${todayStr()}.json`, JSON.stringify(backup, null, 2), "application/json");
      break;
    }

    case "toggle-add-form":
      state.showAddForm = !state.showAddForm;
      render();
      break;

    case "submit-add-form": {
      const title = document.getElementById("new-song-title").value.trim();
      const artist = document.getElementById("new-song-artist").value.trim();
      const level = document.getElementById("new-song-level").value;
      const lyrics = document.getElementById("new-song-lyrics").value;
      if (!title || !lyrics.trim()) return;
      const verses = lyrics.split("\n").map((v) => v.trim()).filter(Boolean);
      persistSong({
        id: `song-${Date.now()}`,
        title, artist: artist || "Artista desconhecido", level, verses,
        analyses: {}, createdAt: Date.now(),
      });
      state.showAddForm = false;
      render();
      break;
    }

    case "delete-song":
      deleteSongById(el.dataset.id);
      render();
      break;

    case "open-song":
    case "pick-study-song":
      state.activeSongId = el.dataset.id;
      state.studyIndex = 0;
      state.tab = "study";
      state.analyzeError = null;
      render();
      break;

    case "back-to-library":
      state.activeSongId = null;
      state.tab = "library";
      render();
      break;

    case "prev-verse":
      state.studyIndex = Math.max(0, state.studyIndex - 1);
      state.analyzeError = null;
      render();
      break;
    case "next-verse": {
      const song = state.songs.find((s) => s.id === state.activeSongId);
      state.studyIndex = Math.min(song.verses.length - 1, state.studyIndex + 1);
      state.analyzeError = null;
      render();
      break;
    }

    case "analyze-verse": {
      if (!state.apiKey) {
        state.showSettings = true;
        render();
        return;
      }
      const song = state.songs.find((s) => s.id === state.activeSongId);
      const verse = song.verses[state.studyIndex];
      state.analyzing = true;
      state.analyzeError = null;
      render();
      try {
        const result = await analyzeVerse(verse, song, state.apiKey);
        const nextSong = { ...song, analyses: { ...song.analyses, [state.studyIndex]: result } };
        persistSong(nextSong);
      } catch (err) {
        state.analyzeError = "Não foi possível analisar este verso agora (" + err.message + ").";
      } finally {
        state.analyzing = false;
        render();
      }
      break;
    }

    case "add-flashcards": {
      const index = Number(el.dataset.index);
      const song = state.songs.find((s) => s.id === state.activeSongId);
      const analysis = song.analyses[index];
      if (!analysis?.vocab?.length) return;
      const cards = analysis.vocab.map((v) => ({
        id: `${song.id}-${index}-${v.word}`,
        word: v.word, meaning: v.meaning, example: v.example,
        songTitle: song.title, ease: 2.3, interval: 0, reps: 0, dueDate: todayStr(),
      }));
      addFlashcards(cards);
      state.addedFlashSet.add(`${song.id}:${index}`);
      render();
      break;
    }

    case "check-cloze": {
      document.querySelectorAll(".cloze-input").forEach((input) => {
        state.practiceValues[Number(input.dataset.blankIndex)] = input.value;
      });
      state.practiceChecked = true;
      render();
      break;
    }
    case "retry-cloze":
      state.practiceChecked = false;
      state.practiceValues = {};
      render();
      break;

    case "reveal-flashcard":
      state.flashRevealed = true;
      render();
      break;

    case "rate-flashcard": {
      const due = state.flashcards.filter((c) => !c.dueDate || c.dueDate <= todayStr());
      const current = due[state.flashPos];
      updateFlashcardById(reviewCard(current, Number(el.dataset.rating)));
      state.flashRevealed = false;
      state.flashPos += 1;
      render();
      break;
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset?.action === "practice-select-song") {
    state.practiceSongId = e.target.value;
    state.practiceVerseIndex = null;
    state.practiceChecked = false;
    state.practiceValues = {};
    render();
  }
  if (e.target.dataset?.action === "practice-select-verse") {
    state.practiceVerseIndex = Number(e.target.value);
    state.practiceChecked = false;
    state.practiceValues = {};
    render();
  }
  if (e.target.dataset?.action === "import-data") {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const backup = JSON.parse(reader.result);
        state.songs = backup.songs || [];
        state.flashcards = backup.flashcards || [];
        state.stats = backup.stats || state.stats;
        saveJSON("mec_songs_index", state.songs.map(({ id, title, artist, level }) => ({ id, title, artist, level })));
        state.songs.forEach((s) => saveJSON(`mec_song_${s.id}`, s));
        saveJSON("mec_flashcards", state.flashcards);
        saveJSON("mec_stats", state.stats);
        state.showSettings = false;
        render();
        alert("Backup importado com sucesso.");
      } catch (err) {
        alert("Não foi possível ler esse arquivo de backup.");
      }
    };
    reader.readAsText(file);
  }
});

init();
