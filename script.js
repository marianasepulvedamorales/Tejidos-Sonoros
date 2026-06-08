"use strict";

// ══════════════════════════════════════════════════════════
//  CONSTANTES
// ══════════════════════════════════════════════════════════
const PIXELS_PER_BEAT = 60;
const TRACK_HEIGHT    = 72;
const TRACK_COLORS    = [
  '#7c6af7','#f76ac3','#4ad8b0','#f7a24a',
  '#4ab8f7','#f76a6a','#a2f74a','#c86af7',
  '#f7d84a','#4af7c8','#f74a7c','#7af74a'
];

// ══════════════════════════════════════════════════════════
//  ESTADO LOCAL
//
//  appState es el espejo local del estado del servidor.
//  Solo se modifica cuando llegan mensajes del servidor
//  (incluidos los propios, que el servidor reenvía a todos).
//  Esto garantiza que todos los usuarixs estén sincronizados.
// ══════════════════════════════════════════════════════════
const appState = {
  tracks: [],
  clips:  [],
  bpm:    90,
  isPlaying:   false,
  loopActive:  false,
  totalBeats:  64,
  pixelsPerBeat: PIXELS_PER_BEAT,
};

// Metadatos propios (asignados por el servidor al conectar)
let myInfo = null;  // { id, name, color }

// Buffers de audio decodificados: clipId → Tone.ToneAudioBuffer
// Los guardamos separados del estado para no serializar el buffer
const audioBuffers = new Map();

// Otros participantes y sus cursores
const remoteCursors = new Map();  // userId → { beat, element }
const remoteUsers = new Map();  // userId → { id, name, color }

let nextLocalTrackId = 1000; // IDs locales temporales antes de confirmar con servidor
let nextLocalClipId  = 1000;

let audioInitialized = false;
let scheduledPart    = null;
let animFrameId      = null;

// ══════════════════════════════════════════════════════════
//  WEBSOCKET — CONEXIÓN
// ══════════════════════════════════════════════════════════

let ws = null;

/*
  connectToServer(): abre la conexión WebSocket con el servidor.
  Se llama al hacer clic en "CONECTAR" en el diálogo.
*/
function connectToServer() {
  const name      = document.getElementById('inputName').value.trim() || 'participante';
  const serverUrl = document.getElementById('inputServer').value.trim();

  // Ocultar el diálogo de conexión
  document.getElementById('connect-dialog').style.display = 'none';

  setConnStatus('connecting', 'conectando…');

  try {
    ws = new WebSocket(serverUrl);
  } catch(e) {
    setConnStatus('error', 'URL inválida');
    document.getElementById('connect-dialog').style.display = 'flex';
    return;
  }

  // El servidor lee el nombre del primer mensaje que enviamos
  ws.onopen = () => {
    // Enviamos nuestro nombre al conectar
    sendWS({ type: 'SET_NAME', name });
    setConnStatus('connected', 'conectado');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch(e) {
      console.error('Error parseando mensaje:', e);
    }
  };

  ws.onclose = () => {
    setConnStatus('error', 'desconectado');
    notify('⚡ conexión perdida — recarga para reconectar', '#f04f4f');
  };

  ws.onerror = () => {
    setConnStatus('error', 'error de conexión');
  };
}

/*
  sendWS(): envía un mensaje al servidor.
  Verifica que la conexión esté abierta antes de enviar.
*/
function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function setConnStatus(state, label) {
  const dot = document.getElementById('connDot');
  dot.className = 'conn-dot ' + state;
  document.getElementById('connLabel').textContent = label;
}

// ══════════════════════════════════════════════════════════
//  MANEJADOR DE MENSAJES DEL SERVIDOR
//
//  Aquí se aplican todos los cambios que vienen del servidor.
//  Tanto las acciones propias (confirmadas) como las de
//  otros participantes llegan por esta vía.
// ══════════════════════════════════════════════════════════
async function handleServerMessage(msg) {
  switch (msg.type) {

    // ── Estado inicial completo ──────────────────────────
    case 'FULL_STATE': {
      myInfo = msg.you;

      // Reconstruir la lista de participantes conocidos
      for (const c of msg.users) {
        remoteUsers.set(c.id, c);
      }

      // Aplicar BPM
      appState.bpm = msg.state.bpm;
      document.getElementById('bpmSlider').value = appState.bpm;
      document.getElementById('bpmVal').textContent = appState.bpm;

      // Reconstruir pistas
      appState.tracks = msg.state.tracks;
      // Crear nodos de Tone.js para cada pista existente
      for (const t of appState.tracks) {
        await initTrackAudio(t);
      }

      // Reconstruir clips (y decodificar buffers de audio)
      appState.clips = [];
      for (const clip of msg.state.clips) {
        if (clip.audioData) {
          await decodeClipAudio(clip);
        }
        appState.clips.push(clip);
      }

      renderAll();
      updateParticipants();
      notify(`∿ bienvenido, ${myInfo.name}`);
      break;
    }

    // ── Nuevo participante ───────────────────────────────
    case 'USER_JOINED': {
      remoteUsers.set(msg.user.id, msg.user);
      updateParticipants();
      notify(`→ ${msg.user.name} se unió`, msg.user.color);
      break;
    }

    // ── Participante se fue ──────────────────────────────
    case 'USER_LEFT': {
      remoteUsers.delete(msg.user.id);
      // Eliminar su cursor de la línea temporal
      const cursor = remoteCursors.get(msg.user.id);
      if (cursor && cursor.element) cursor.element.remove();
      remoteCursors.delete(msg.user.id);
      updateParticipants();
      notify(`← ${msg.user.name} salió`, '#888');
      break;
    }

    // ── Nueva pista ──────────────────────────────────────
    case 'ADD_TRACK': {
      appState.tracks.push(msg.track);
      await initTrackAudio(msg.track);
      renderAll();
      if (msg.from !== myInfo?.id) {
        const creator = remoteUsers.get(msg.from);
        notify(`♩ ${creator?.name || '?'} añadió "${msg.track.name}"`, msg.track.color);
      }
      break;
    }

    // ── Pista eliminada ──────────────────────────────────
    case 'REMOVE_TRACK': {
      const t = appState.tracks.find(t => t.id === msg.trackId);
      if (t) { t._channel?.dispose(); t._synth?.dispose(); }
      appState.tracks = appState.tracks.filter(t => t.id !== msg.trackId);
      appState.clips  = appState.clips.filter(c => c.trackId !== msg.trackId);
      renderAll();
      break;
    }

    // ── Pista actualizada (vol, pan, mute, tono y efectos) ───────────────
    case 'UPDATE_TRACK': {
      const t = appState.tracks.find(t => t.id === msg.trackId);
      if (!t) break;
      Object.assign(t, msg.updates);
      applyTrackAudio(t);
      renderTrackPanel();
      break;
    }

    // ── Nuevo clip ───────────────────────────────────────
    case 'ADD_CLIP': {
      if (msg.clip.audioData) {
        document.getElementById('uploadProgress').textContent = '↓ recibiendo audio…';
        await decodeClipAudio(msg.clip);
        document.getElementById('uploadProgress').textContent = '';
      }
      appState.clips.push(msg.clip);
      renderTrackRows();
      updateStatusBar();
      if (msg.from !== myInfo?.id) {
        const creator = remoteUsers.get(msg.from);
        notify(`♪ ${creator?.name || '?'} subió "${msg.clip.name}"`, TRACK_COLORS[msg.from % TRACK_COLORS.length]);
      }
      break;
    }

    // ── Clip eliminado ───────────────────────────────────
    case 'REMOVE_CLIP': {
      appState.clips = appState.clips.filter(c => c.id !== msg.clipId);
      audioBuffers.delete(msg.clipId);
      renderTrackRows();
      updateStatusBar();
      break;
    }

    // ── Clip movido ──────────────────────────────────────
    case 'MOVE_CLIP': {
      const c = appState.clips.find(c => c.id === msg.clipId);
      if (c) {
        c.startBeat = msg.startBeat;
        // Actualizar posición del elemento DOM sin rerender completo
        const el = document.querySelector(`[data-clip-id="${msg.clipId}"]`);
        if (el) el.style.left = (msg.startBeat * appState.pixelsPerBeat) + 'px';
      }
      break;
    }

    // ── Clip redimensionado ──────────────────────────────
    case 'RESIZE_CLIP': {
      const c = appState.clips.find(c => c.id === msg.clipId);
      if (c) {
        c.durationBeats = msg.durationBeats;
        const el = document.querySelector(`[data-clip-id="${msg.clipId}"]`);
        if (el) el.style.width = Math.max(20, msg.durationBeats * appState.pixelsPerBeat) + 'px';
      }
      break;
    }

    // ── BPM cambiado ─────────────────────────────────────
    case 'SET_BPM': {
      appState.bpm = msg.bpm;
      document.getElementById('bpmSlider').value = msg.bpm;
      document.getElementById('bpmVal').textContent = msg.bpm;
      if (audioInitialized) Tone.Transport.bpm.value = msg.bpm;
      break;
    }

    // ── Transport remoto ────────────────────────────────
    case 'TRANSPORT': {
      // Opcional: sincronizar play/stop con otros participantes
      // Por ahora solo notificamos, sin forzar reproducción
      const creator = remoteUsers.get(msg.from);
      if (msg.from !== myInfo?.id) {
        notify(`${creator?.name || '?'} ${msg.action === 'play' ? '▶' : '■'}`, '#888');
      }
      break;
    }

    // ── Nombre/color de participante actualizado ─────────
    case 'USER_UPDATED': {
      const c = msg.user;
      if (myInfo && c.id === myInfo.id) myInfo = { ...myInfo, ...c };
      if (remoteUsers.has(c.id)) remoteUsers.set(c.id, { ...remoteUsers.get(c.id), ...c });
      updateParticipants();
      break;
    }

    // ── Cursor remoto ────────────────────────────────────
    case 'CURSOR': {
      updateRemoteCursor(msg.from, msg.beat, msg.color);
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════
//  AUDIO CON TONE.JS
// ══════════════════════════════════════════════════════════

async function ensureAudio() {
  if (audioInitialized) return;
  await Tone.start();
  Tone.Transport.bpm.value = appState.bpm;
  audioInitialized = true;
}

/*
  initTrackAudio(): crea los nodos de Tone.js para una pista.
  Los nodos se guardan en la pista con prefijo _ para distinguirlos
  de los datos serializables.
*/
async function initTrackAudio(track) {
  if (track._channel) return;
  track._channel = new Tone.Channel({ volume: 0, pan: 0 }).toDestination();

  // Cadena de efectos: synth → distorsión → delay → reverb → canal
  // wet: 0 significa que cada efecto arranca apagado
  track._reverb = new Tone.Reverb({ decay: 2.5, wet: 0 }).connect(track._channel);
  track._delay  = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0 }).connect(track._reverb);
  track._dist   = new Tone.Distortion({ distortion: 0.6, wet: 0 }).connect(track._delay);

  track._synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope:   { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.8 }
  }).connect(track._dist);
}

function applyTrackAudio(track) {
  if (!track._channel) return;
  const db = track.volume === 0 ? -Infinity : (track.volume / 100) * 66 - 60;
  track._channel.volume.value = db;
  track._channel.pan.value    = (track.pan - 50) / 50;
  track._channel.mute         = track.muted;
  // Detune: semitones * 100 = cents. 2 octavas hacia arriba y 2 hacia abajo.
  if (track._synth)  track._synth.set({ detune: (track.detune || 0) * 100 });
  if (track._reverb) track._reverb.wet.value = (track.reverb || 0) / 100;
  if (track._delay)  track._delay.wet.value  = (track.delay  || 0) / 100;
  if (track._dist)   track._dist.wet.value   = (track.dist   || 0) / 100;
}


/*
  decodeClipAudio(): convierte el base64 del clip a un ToneAudioBuffer.
  
  El flujo es:
    base64 → ArrayBuffer → AudioBuffer → ToneAudioBuffer
  
  El ToneAudioBuffer resultante se guarda en audioBuffers por clipId,
  separado del estado serializable.
*/
async function decodeClipAudio(clip) {
  if (!clip.audioData) return;
  await ensureAudio();
  try {
    // Decodificar base64 → Uint8Array
    const binary    = atob(clip.audioData);
    const bytes     = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Decodificar el audio con la Web Audio API
    const audioCtx  = Tone.getContext().rawContext;
    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));

    // Envolver en ToneAudioBuffer para compatibilidad con Tone.Player
    const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
    audioBuffers.set(clip.id, toneBuffer);
  } catch(e) {
    console.error('Error decodificando audio del clip', clip.id, e);
  }
}

// ══════════════════════════════════════════════════════════
//  ACCIONES LOCALES → SERVIDOR
//
//  Cada acción del usuario local se envía al servidor.
//  El servidor la procesa y la reenvía a todos (incluyendo
//  al remitente), que entonces actualiza su estado local.
//  Esto garantiza consistencia: nadie aplica cambios
//  antes de que el servidor los confirme.
// ══════════════════════════════════════════════════════════

function addTrackLocal(name = null) {
  const id    = nextLocalTrackId++;
  const color = TRACK_COLORS[(id) % TRACK_COLORS.length];
  const track = {
    id, color,
    name:   name || `pista ${id}`,
    volume: 75,
    pan:    50,
    muted:  false,
    soloed: false,
    createdBy: myInfo?.id,
  };
  sendWS({ type: 'ADD_TRACK', track });
  return track;
}

function removeTrackLocal(id) {
  sendWS({ type: 'REMOVE_TRACK', trackId: id });
}

function updateTrackLocal(id, updates) {
  const t = appState.tracks.find(t => t.id === id);
  if (t) {
    Object.assign(t, updates);
    applyTrackAudio(t);
    if ('muted' in updates || 'soloed' in updates) renderTrackPanel();
  }
  sendWS({ type: 'UPDATE_TRACK', trackId: id, updates });
}

function addClipLocal(trackId, startBeat, durationBeats, audioData = null, name = 'clip') {
  const id   = nextLocalClipId++;
  const type = audioData ? 'audio' : 'synth';
  const clip = { id, trackId, startBeat, durationBeats, name, type, audioData,
                 createdBy: myInfo?.id };
  sendWS({ type: 'ADD_CLIP', clip });
}

function removeClipLocal(id) {
  sendWS({ type: 'REMOVE_CLIP', clipId: id });
}

/*
  importAudio(): convierte los archivos del usuario a base64
  y los envía al servidor como parte del clip.
  
  Por qué base64:
    WebSocket puede enviar binario (ArrayBuffer), pero estamos
    usando JSON para todos los mensajes (más simple y debuggeable).
    La penalización de tamaño de base64 (~33% más grande) es
    aceptable para archivos de audio de duración moderada.
  
  Límite práctico: archivos de hasta ~15MB funcionan bien.
  Para archivos más grandes, considerar un upload HTTP separado
  y compartir solo la URL.
*/
async function importAudio(event) {
  await ensureAudio();
  const files = Array.from(event.target.files);

  for (const file of files) {
    // Verificar tamaño (límite 20MB por archivo)
    if (file.size > 20 * 1024 * 1024) {
      notify(`⚠ "${file.name}" supera 20MB`, '#f7a24a');
      continue;
    }

    document.getElementById('uploadProgress').textContent = `↑ cargando ${file.name}…`;

    try {
      // Leer el archivo como ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      // Convertir a base64
      const bytes    = new Uint8Array(arrayBuffer);
      let   binary   = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64   = btoa(binary);

      // Calcular duración decodificando localmente
      const audioCtx   = Tone.getContext().rawContext;
      const audioBuf   = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const durationBeats = audioBuf.duration * (appState.bpm / 60);

      // Crear pista y clip
      const trackName = file.name.replace(/\.[^.]+$/, '');
      addTrackLocal(trackName); // el servidor nos devolverá la pista confirmada

      // Pequeño delay para que la pista se cree antes del clip
      // En producción esto se resolvería con IDs únicos globales (UUID)
      setTimeout(() => {
        // Buscar la pista recién creada por nombre
        const track = appState.tracks.find(t => t.name === trackName);
        if (track) {
          addClipLocal(track.id, 0, durationBeats, base64, trackName);
        }
      }, 200);

      document.getElementById('uploadProgress').textContent = '';
    } catch(e) {
      console.error('Error cargando audio:', e);
      notify(`⚠ Error cargando ${file.name}`, '#f04f4f');
      document.getElementById('uploadProgress').textContent = '';
    }
  }
  event.target.value = '';
}

// ══════════════════════════════════════════════════════════
//  TRANSPORTE
// ══════════════════════════════════════════════════════════

async function togglePlay() {
  await ensureAudio();
  if (appState.isPlaying) {
    Tone.Transport.pause();
    appState.isPlaying = false;
    cancelAnimationFrame(animFrameId);
    sendWS({ type: 'TRANSPORT', action: 'pause' });
  } else {
    scheduleAllClips();
    Tone.Transport.start();
    appState.isPlaying = true;
    animatePlayhead();
    sendWS({ type: 'TRANSPORT', action: 'play', position: Tone.Transport.seconds });
  }
  updateTransportUI();
}

async function stopTransport() {
  await ensureAudio();
  Tone.Transport.stop();
  appState.isPlaying = false;
  cancelAnimationFrame(animFrameId);
  document.getElementById('playhead').style.left = '0px';
  sendWS({ type: 'TRANSPORT', action: 'stop' });
  updateTransportUI();
  updateStatusBar();
}

function toggleLoop() {
  appState.loopActive = !appState.loopActive;
  if (appState.loopActive) {
    Tone.Transport.loop      = true;
    Tone.Transport.loopStart = '0:0:0';
    Tone.Transport.loopEnd   = '4:0:0'; // 4 compases
  } else {
    Tone.Transport.loop = false;
  }
  document.getElementById('btnLoop').textContent = appState.loopActive ? 'LOOP ●' : 'LOOP ○';
  document.getElementById('btnLoop').classList.toggle('active', appState.loopActive);
}

function setBPM(val) {
  appState.bpm = parseInt(val);
  document.getElementById('bpmVal').textContent = val;
  if (audioInitialized) Tone.Transport.bpm.value = appState.bpm;
  sendWS({ type: 'SET_BPM', bpm: appState.bpm });
}

function scheduleAllClips() {
  if (scheduledPart) { scheduledPart.dispose(); scheduledPart = null; }

  const events = appState.clips.map(clip => {
    const bars  = Math.floor(clip.startBeat / 4);
    const beats = clip.startBeat % 4;
    return [`${bars}:${beats}:0`, clip];
  });

  if (!events.length) return;

  scheduledPart = new Tone.Part((time, clip) => {
    playClipAtTime(clip, time);
  }, events);
  scheduledPart.start(0);
}

function playClipAtTime(clip, time) {
  const track = appState.tracks.find(t => t.id === clip.trackId);
  if (!track || !track._channel) return;
  if (track._channel.mute) return;

  const durationSec = clip.durationBeats / (appState.bpm / 60);

  if (clip.type === 'audio') {
    const buf = audioBuffers.get(clip.id);
    if (!buf) return;
    const player = new Tone.Player(buf).connect(track._dist || track._channel);
    player.start(time);
    markClipPlaying(clip.id, true);
    setTimeout(() => {
      player.stop(); player.dispose();
      markClipPlaying(clip.id, false);
    }, (durationSec + 0.2) * 1000);
  } else {
    const notes = ['C4','E4','G4','B4'];
    track._synth?.triggerAttackRelease(
      notes.slice(0, Math.min(4, Math.ceil(clip.durationBeats))),
      durationSec * 0.9, time
    );
    markClipPlaying(clip.id, true);
    setTimeout(() => markClipPlaying(clip.id, false), durationSec * 1000);
  }
}

function markClipPlaying(clipId, playing) {
  const el = document.querySelector(`[data-clip-id="${clipId}"]`);
  if (el) el.classList.toggle('playing', playing);
}

// ══════════════════════════════════════════════════════════
//  ANIMACIÓN Y CURSORES
// ══════════════════════════════════════════════════════════

let lastCursorBroadcast = 0;

function animatePlayhead() {
  const seconds = Tone.Transport.seconds;
  const beats   = seconds * (appState.bpm / 60);
  const px      = beats * appState.pixelsPerBeat;

  document.getElementById('playhead').style.left = px + 'px';
  updateStatusBar(seconds, beats);

  // Broadcast de cursor cada 100ms para no saturar el servidor
  const now = Date.now();
  if (now - lastCursorBroadcast > 100) {
    sendWS({ type: 'CURSOR', beat: beats });
    lastCursorBroadcast = now;
  }

  // Auto-scroll
  const area = document.getElementById('timelineArea');
  if (px - area.scrollLeft > area.userWidth * 0.75) {
    area.scrollLeft = px - area.userWidth * 0.3;
  }

  if (appState.isPlaying) animFrameId = requestAnimationFrame(animatePlayhead);
}

/*
  updateRemoteCursor(): actualiza la línea vertical del cursor
  de otro participante en la línea temporal.
*/
function updateRemoteCursor(userId, beat, color) {
  const container = document.getElementById('tracksContainer');
  let entry = remoteCursors.get(userId);

  if (!entry) {
    // Crear el elemento del cursor
    const el    = document.createElement('div');
    el.className = 'remote-cursor';
    el.style.background = color || '#fff';
    const label = document.createElement('div');
    label.className = 'remote-cursor-label';
    label.style.color = color || '#fff';
    const user = remoteUsers.get(userId);
    label.textContent = user?.name?.slice(0, 8) || '?';
    el.appendChild(label);
    container.appendChild(el);
    entry = { beat: 0, element: el };
    remoteCursors.set(userId, entry);
  }

  entry.beat = beat;
  entry.element.style.left = (beat * appState.pixelsPerBeat) + 'px';
}

// ══════════════════════════════════════════════════════════
//  RENDERIZADO
// ══════════════════════════════════════════════════════════

function renderAll() {
  renderTrackPanel();
  renderTrackRows();
}

function renderTrackPanel() {
  const list = document.getElementById('trackList');
  list.innerHTML = '';
  for (const t of appState.tracks) {
    const creator = remoteUsers.get(t.createdBy) || myInfo;
    const el = document.createElement('div');
    el.className = 'track-item';
    el.style.setProperty('--track-color', t.color);
    el.style.cssText += `border-left: 3px solid ${t.color};padding-left:9px;`;
    el.innerHTML = `
      <div class="track-name">
        <span class="track-color-dot" style="background:${t.color}"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px">${escHtml(t.name)}</span>
        <span class="track-creator" style="background:${creator?.color||'#444'};color:#000"
              title="${escHtml(creator?.name||'?')}">
          ${(creator?.name||'?').slice(0,2).toUpperCase()}
        </span>
        <button class="btn-mini ${t.muted?'muted':''}" onclick="updateTrackLocal(${t.id},{muted:${!t.muted}})">M</button>
        <button class="btn-mini ${t.soloed?'soloed':''}" onclick="toggleSoloLocal(${t.id})">S</button>
        <button class="btn-mini" style="color:var(--danger);border-color:var(--danger)"
                onclick="if(confirm('¿Eliminar pista?'))removeTrackLocal(${t.id})">✕</button>
      </div>
      <div class="track-controls">
        <label>Vol</label>
        <input type="range" min="0" max="100" value="${t.volume||75}"
               oninput="updateTrackLocal(${t.id},{volume:+this.value})">
        <label>Pan</label>
        <input type="range" min="0" max="100" value="${t.pan||50}"
               oninput="updateTrackLocal(${t.id},{pan:+this.value})">
        <label>Tono</label>
        <input type="range" min="-24" max="24" value="${t.detune||0}"
               oninput="updateTrackLocal(${t.id},{detune:+this.value})">
      </div>
      <div class="track-controls">
        <label>Rev</label>
        <input type="range" min="0" max="100" value="${t.reverb||0}"
               oninput="updateTrackLocal(${t.id},{reverb:+this.value})">
        <label>Dly</label>
        <input type="range" min="0" max="100" value="${t.delay||0}"
               oninput="updateTrackLocal(${t.id},{delay:+this.value})">
        <label>Dist</label>
        <input type="range" min="0" max="100" value="${t.dist||0}"
               oninput="updateTrackLocal(${t.id},{dist:+this.value})">
      </div>
      
    `;
    list.appendChild(el);
  }
  syncScrollListeners();
}

function toggleSoloLocal(id) {
  const t = appState.tracks.find(t => t.id === id);
  if (!t) return;
  const newSolo = !t.soloed;
  updateTrackLocal(id, { soloed: newSolo });
  const hasSolo = appState.tracks.some(tr => tr.id === id ? newSolo : tr.soloed);
  appState.tracks.forEach(tr => {
    if (tr._channel) tr._channel.mute = hasSolo ? !tr.soloed : tr.muted;
  });
}

function renderTrackRows() {
  const container = document.getElementById('tracksContainer');
  const playhead  = document.getElementById('playhead');
  container.innerHTML = '';
  container.appendChild(playhead);

  const totalPx = Math.max(
    appState.totalBeats * appState.pixelsPerBeat,
    ...appState.clips.map(c => (c.startBeat + c.durationBeats) * appState.pixelsPerBeat),
    200
  );
  container.style.width    = (totalPx + 200) + 'px';
  container.style.minHeight = (appState.tracks.length * TRACK_HEIGHT) + 'px';
  document.documentElement.style.setProperty('--beat-w', appState.pixelsPerBeat + 'px');

  for (const t of appState.tracks) {
    const row = document.createElement('div');
    row.className    = 'track-row';
    row.dataset.trackId = t.id;

    // Clic en fila: añadir clip de síntesis
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.clip')) return;
      await ensureAudio();
      const rect = row.getBoundingClientRect();
      const area = document.getElementById('timelineArea');
      const relX = e.clientX - rect.left + area.scrollLeft;
      const beat = snapToGrid(relX / appState.pixelsPerBeat);
      addClipLocal(t.id, beat, 4, null, `clip`);
    });

    for (const clip of appState.clips.filter(c => c.trackId === t.id)) {
      row.appendChild(buildClipElement(clip, t));
    }

    container.appendChild(row);
  }

  // Restaurar cursores remotos
  for (const [userId, entry] of remoteCursors) {
    container.appendChild(entry.element);
  }

  drawRuler();
  updateStatusBar();
}

function buildClipElement(clip, track) {
  const el = document.createElement('div');
  el.className    = 'clip';
  el.dataset.clipId = clip.id;

  const leftPx  = clip.startBeat * appState.pixelsPerBeat;
  const widthPx = Math.max(20, clip.durationBeats * appState.pixelsPerBeat);
  el.style.left       = leftPx + 'px';
  el.style.width      = widthPx + 'px';
  el.style.background = track.color + 'a0';

  // Color del creador en el borde inferior del clip
  const creator = remoteUsers.get(clip.createdBy) || myInfo;
  el.style.setProperty('--creator-color', creator?.color || track.color);
  el.style.cssText += `--creator-color:${creator?.color||track.color}`;
  el.style.borderBottom = `2px solid ${creator?.color || track.color}`;

  el.innerHTML = `
    <div class="clip-name">${escHtml(clip.name)}</div>
    <div class="clip-type">${clip.type === 'audio' ? '♪ audio' : '∿ synth'}</div>
    <div class="clip-resize" data-resize="true"></div>
  `;

  // Waveform
  if (clip.type === 'audio' && audioBuffers.has(clip.id)) {
    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'clip-wave';
    el.appendChild(waveCanvas);
    requestAnimationFrame(() => drawWaveform(waveCanvas, audioBuffers.get(clip.id), track.color));
  }

  makeDraggable(el, clip);

  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (confirm(`¿Eliminar "${clip.name}"?`)) removeClipLocal(clip.id);
  });

  return el;
}

/*
  makeDraggable(): igual que la versión anterior, pero al soltar
  envía MOVE_CLIP o RESIZE_CLIP al servidor en lugar de modificar
  el estado directamente.
*/
function makeDraggable(el, clip) {
  let isDragging = false, isResizing = false;
  let startX = 0, origStart = 0, origDur = 0;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    isResizing = !!e.target.dataset.resize;
    isDragging = !isResizing;
    startX     = e.clientX;
    origStart  = clip.startBeat;
    origDur    = clip.durationBeats;
    el.classList.add('dragging');

    const onMove = (e) => {
      const dBeat = (e.clientX - startX) / appState.pixelsPerBeat;
      if (isDragging) {
        const ns = Math.max(0, origStart + dBeat);
        clip.startBeat = ns;
        el.style.left  = (ns * appState.pixelsPerBeat) + 'px';
      } else {
        const nd = Math.max(0.25, origDur + dBeat);
        clip.durationBeats = nd;
        el.style.width = Math.max(20, nd * appState.pixelsPerBeat) + 'px';
      }
    };

    const onUp = () => {
      if (isDragging) {
        clip.startBeat = snapToGrid(clip.startBeat);
        el.style.left  = (clip.startBeat * appState.pixelsPerBeat) + 'px';
        sendWS({ type: 'MOVE_CLIP', clipId: clip.id, startBeat: clip.startBeat });
      } else {
        clip.durationBeats = snapToGrid(clip.durationBeats);
        el.style.width = Math.max(20, clip.durationBeats * appState.pixelsPerBeat) + 'px';
        sendWS({ type: 'RESIZE_CLIP', clipId: clip.id, durationBeats: clip.durationBeats });
      }
      isDragging = false; isResizing = false;
      el.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (appState.isPlaying) scheduleAllClips();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ══════════════════════════════════════════════════════════
//  PARTICIPANTES
// ══════════════════════════════════════════════════════════

function updateParticipants() {
  const list = document.getElementById('participantsList');
  list.innerHTML = '';

  // Yo primero
  if (myInfo) {
    const av = makeAvatar(myInfo, true);
    list.appendChild(av);
  }

  // Los demás
  for (const [, user] of remoteUsers) {
    if (user.id === myInfo?.id) continue;
    list.appendChild(makeAvatar(user, false));
  }
}

function makeAvatar(user, isMe) {
  const div = document.createElement('div');
  div.className = 'avatar' + (isMe ? ' you' : '');
  div.style.background = user.color;
  div.style.color      = '#000';
  div.title            = user.name + (isMe ? ' (tú)' : '');
  div.textContent      = user.name.slice(0, 2).toUpperCase();
  return div;
}

// ══════════════════════════════════════════════════════════
//  NOTIFICACIONES
// ══════════════════════════════════════════════════════════

function notify(text, color = null) {
  const container = document.getElementById('notifications');
  const el = document.createElement('div');
  el.className = 'notif';
  if (color) el.style.borderLeftColor = color;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ══════════════════════════════════════════════════════════
//  REGLA Y FORMA DE ONDA
// ══════════════════════════════════════════════════════════

function drawRuler() {
  const canvas = document.getElementById('rulerCanvas');
  const area   = document.getElementById('timelineArea');
  const width  = Math.max(area.userWidth, appState.totalBeats * appState.pixelsPerBeat + 200);
  canvas.width = width; canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, 40);
  ctx.font = '9px Courier New';

  for (let beat = 0; beat <= appState.totalBeats; beat++) {
    const x = beat * appState.pixelsPerBeat;
    const isBar = beat % 4 === 0;
    ctx.strokeStyle = isBar ? '#3a3a4a' : '#2a2a38';
    ctx.lineWidth   = isBar ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, isBar ? 0 : 22); ctx.lineTo(x, 40); ctx.stroke();
    if (isBar) {
      ctx.fillStyle = '#8a8899';
      ctx.fillText(`${beat / 4 + 1}`, x + 3, 14);
    }
  }
}

function drawWaveform(canvas, buffer, color) {
  if (!buffer || !canvas.offsetWidth) return;
  canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight;
  const ctx  = canvas.getContext('2d');
  const data = buffer.getChannelData(0);
  const w    = canvas.width, h = canvas.height;
  const step = Math.floor(data.length / w);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i < w; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) { const s = data[i*step+j]||0; if(s<min)min=s; if(s>max)max=s; }
    ctx.moveTo(i, (1-max)/2*h); ctx.lineTo(i, (1-min)/2*h);
  }
  ctx.stroke();
}

// ══════════════════════════════════════════════════════════
//  UTILIDADES
// ══════════════════════════════════════════════════════════

function snapToGrid(beats, grid = 0.25) { return Math.round(beats / grid) * grid; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateStatusBar(seconds = 0, beats = 0) {
  const min  = Math.floor(seconds / 60);
  const sec  = (seconds % 60).toFixed(3).padStart(6, '0');
  const bar  = Math.floor(beats / 4) + 1;
  const beat = Math.floor(beats % 4) + 1;
  document.getElementById('posDisplay').textContent   = `${min}:${sec}`;
  document.getElementById('beatsDisplay').textContent = `${bar}.${beat}.1`;
  document.getElementById('statusText').textContent   = appState.isPlaying ? '▶ reproduciendo' : '■ detenido';
  document.getElementById('clipCountDisplay').textContent = `${appState.clips.length} clips · ${usersCount()} participantes`;
}

function usersCount() { return remoteUsers.size + (myInfo ? 1 : 0); }

function updateTransportUI() {
  const btn = document.getElementById('btnPlay');
  btn.textContent = appState.isPlaying ? '⏸ PAUSE' : '▶ PLAY';
  btn.classList.toggle('active', appState.isPlaying);
  updateStatusBar();
}

function syncScrollListeners() {
  const panel    = document.getElementById('trackPanel');
  const timeline = document.getElementById('timelineArea');
  const syncT = () => { panel.scrollTop = timeline.scrollTop; };
  const syncP = () => { timeline.scrollTop = panel.scrollTop; };
  timeline.removeEventListener('scroll', syncT);
  panel.removeEventListener('scroll', syncP);
  timeline.addEventListener('scroll', syncT);
  panel.addEventListener('scroll', syncP);
}

// ══════════════════════════════════════════════════════════
//  GRABACIÓN DE MICRÓFONO
// ══════════════════════════════════════════════════════════

let mediaRecorder   = null;
let recordingChunks = [];
let isRecording     = false;

async function toggleRecording() {
  if (isRecording) {
    mediaRecorder.stop();
    return;
  }

  await ensureAudio();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch(e) {
    notify('⚠ no se pudo acceder al micrófono', '#f04f4f');
    return;
  }

  recordingChunks = [];
  mediaRecorder   = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordingChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());

    try {
      const blob        = new Blob(recordingChunks, { type: mediaRecorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();

      // base64
      const bytes = new Uint8Array(arrayBuffer);
      let binary  = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      // duración en beats
      const audioCtx     = Tone.getContext().rawContext;
      const audioBuf     = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const durationBeats = audioBuf.duration * (appState.bpm / 60);

      const now       = new Date();
      const trackName = `mic ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

      addTrackLocal(trackName);
      setTimeout(() => {
        const track = appState.tracks.find(t => t.name === trackName);
        if (track) addClipLocal(track.id, 0, durationBeats, base64, trackName);
      }, 200);

      notify('⏺ grabación guardada', '#4ad8b0');
    } catch(e) {
      console.error('Error procesando grabación:', e);
      notify('⚠ error al procesar la grabación', '#f04f4f');
    }

    isRecording = false;
    updateRecBtn();
  };

  mediaRecorder.start();
  isRecording = true;
  updateRecBtn();
  notify('⏺ grabando desde micrófono…', '#f76a6a');
}

function updateRecBtn() {
  const btn = document.getElementById('btnRec');
  if (!btn) return;
  btn.textContent = isRecording ? '⏹ STOP' : '⏺ REC';
  btn.classList.toggle('active', isRecording);
}

// ══════════════════════════════════════════════════════════
//  ATAJOS DE TECLADO
// ══════════════════════════════════════════════════════════

document.addEventListener('keydown', async (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); await togglePlay(); }
  if (e.code === 'Escape') { await stopTransport(); }
});

window.addEventListener('resize', drawRuler);
