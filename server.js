/**
 * ============================================================
 * SERVIDOR DEL SECUENCIADOR POLIFÓNICO COLECTIVO
 * ============================================================
 *
 * Tecnología: Node.js + ws (WebSocket)
 *
 * Por qué WebSockets y no HTTP normal:
 *   HTTP es petición-respuesta: el cliente pregunta, el servidor
 *   responde y la conexión se cierra. Para un secuenciador colectivo
 *   necesitamos que el servidor EMPUJE cambios a todos los clientes
 *   en tiempo real, sin que cada uno tenga que preguntar.
 *   WebSocket mantiene la conexión abierta en ambos sentidos.
 *
 * Por qué no usar un servicio de terceros (Firebase, etc.):
 *   Porque los buffers de audio pueden pesar megabytes.
 *   Necesitamos control sobre el tamaño máximo de mensajes
 *   y la lógica de distribución.
 *
 * ARQUITECTURA:
 *   - Un estado central (serverState) con pistas y clips
 *   - Cuando un cliente envía un cambio, el servidor lo valida,
 *     actualiza el estado y lo reenvía a TODOS los demás clientes
 *   - Los buffers de audio se transmiten como base64 (binario → texto)
 *     porque JSON no puede contener datos binarios directamente
 *
 * INSTALAR Y CORRER:
 *    
 *   node server.js
 *
 * HOSPEDAR GRATIS:
 *   - Railway.app: conecta tu repo de GitHub, detecta Node.js automáticamente
 *   - Render.com: igual, plan gratuito disponible
 *   - Fly.io: más control, también gratuito para proyectos pequeños
 * ============================================================
 */

const WebSocket = require('ws');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');

// Puerto: usa la variable de entorno PORT si existe (para Railway/Render)
// o 8080 como valor por defecto local
const PORT = process.env.PORT || 8080;

// ──────────────────────────────────────────────────────────
//  ESTADO DEL SERVIDOR
//  Cuando un usuario nuevo se conecta, recibe una copia
//  completa de este estado para sincronizarse.
// ──────────────────────────────────────────────────────────
const serverState = {
  bpm:    90,
  tracks: [],  // { id, name, color, volume, pan }
  clips:  [],  // { id, trackId, startBeat, durationBeats, name, type, audioData? }
  // audioData: string base64 del buffer de audio (solo para clips tipo 'audio')
};

// Mapa de usuario conectados: ws → { id, name, color }
const clients = new Map();
let nextClientId = 1;

// Colores asignados a cada participante (para identificación visual)
const CLIENT_COLORS = [
  '#7c6af7','#f76ac3','#4ad8b0','#f7a24a',
  '#4ab8f7','#f76a6a','#a2f74a','#c86af7',
  '#f7d84a','#4af7c8','#f74a7c','#7af74a'
];

// ──────────────────────────────────────────────────────────
//  SERVIDOR HTTP
//
//  Además del WebSocket, servimos el archivo HTML del cliente
//  directamente desde el mismo servidor. Así solo hay que
//  compartir una URL y todos entran con el mismo cliente.
// ──────────────────────────────────────────────────────────
// Mapa de extensiones a tipos MIME
// Necesario para que el navegador interprete cada archivo correctamente
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
};

const httpServer = http.createServer((req, res) => {
 
  const urlPath  = req.url === '/' ? '/secuenciador.html' : req.url;
  const ext      = path.extname(urlPath);
  const mimeType = MIME[ext];

  
  if (!mimeType) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const filePath = path.join(__dirname, urlPath);
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mimeType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end(`No se encontró ${urlPath}`);
  }
});

// ──────────────────────────────────────────────────────────
//  SERVIDOR WEBSOCKET
//
//  Lo montamos sobre el mismo servidor HTTP para que ambos
//  corran en el mismo puerto. El cliente se conecta con:
//    ws://tu-servidor:8080   (local)
//    wss://tu-app.railway.app  (producción con TLS)
// ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  server: httpServer,
  // Tamaño máximo de mensaje: 50MB para permitir archivos de audio grandes
  maxPayload: 50 * 1024 * 1024
});

wss.on('connection', (ws) => {
  // Asignar identidad al nuevo cliente
  const clientId    = nextClientId++;
  const clientColor = CLIENT_COLORS[(clientId - 1) % CLIENT_COLORS.length];
  const clientInfo  = { id: clientId, name: `participante ${clientId}`, color: clientColor };
  clients.set(ws, clientInfo);

  console.log(`[+] ${clientInfo.name} conectado. Total: ${clients.size}`);

  // ── 1. Enviar estado completo al cliente que acaba de entrar ──
  //    Esto sincroniza al recién llegado con todo lo que ya existe
  send(ws, {
    type:    'FULL_STATE',
    state:   serverState,
    you:     clientInfo,
    // Lista de participantes actuales (sin los ws, solo metadatos)
    clients: Array.from(clients.values()),
  });

  // ── 2. Notificar a todos que llegó alguien nuevo ──────────────
  broadcast({
    type:   'CLIENT_JOINED',
    client: clientInfo,
    total:  clients.size,
  }, ws); // excluir al recién llegado (ya sabe que llegó)

  // ── 3. Manejar mensajes entrantes ────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('Mensaje inválido:', e.message);
      return;
    }

    handleMessage(ws, clientInfo, msg);
  });

  // ── 4. Manejar desconexión ────────────────────────────────────
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[-] ${clientInfo.name} desconectado. Total: ${clients.size}`);
    broadcast({
      type:   'CLIENT_LEFT',
      client: clientInfo,
      total:  clients.size,
    });
  });

  ws.on('error', (err) => {
    console.error(`Error con ${clientInfo.name}:`, err.message);
  });
});

// ──────────────────────────────────────────────────────────
//  MANEJADOR DE MENSAJES
//
//  Cada acción del cliente llega como un objeto JSON con `type`.
//  El servidor actualiza su estado y reenvía el cambio a todos.
//
//  Tipos de mensaje:
//    ADD_TRACK      — alguien crea una pista
//    REMOVE_TRACK   — alguien elimina una pista
//    UPDATE_TRACK   — alguien cambia volumen/pan/mute de una pista
//    ADD_CLIP       — alguien añade un clip (puede incluir audio en base64)
//    REMOVE_CLIP    — alguien elimina un clip
//    MOVE_CLIP      — alguien arrastra un clip a otro tiempo
//    RESIZE_CLIP    — alguien cambia la duración de un clip
//    SET_BPM        — alguien cambia el tempo global
//    TRANSPORT      — alguien presiona play/stop (opcional: sincronizar)
//    CURSOR         — posición del cursor de un participante (tiempo real)
// ──────────────────────────────────────────────────────────
function handleMessage(ws, from, msg) {
  switch (msg.type) {

    case 'ADD_TRACK': {
      // Validar que no haya demasiadas pistas
      if (serverState.tracks.length >= 24) {
        send(ws, { type: 'ERROR', message: 'Máximo 24 pistas alcanzado' });
        return;
      }
      serverState.tracks.push(msg.track);
      broadcast({ type: 'ADD_TRACK', track: msg.track, from: from.id }, null);
      console.log(`  [pista] ${from.name} añadió "${msg.track.name}"`);
      break;
    }

    case 'REMOVE_TRACK': {
      serverState.tracks = serverState.tracks.filter(t => t.id !== msg.trackId);
      // Eliminar también todos los clips de esa pista
      serverState.clips  = serverState.clips.filter(c => c.trackId !== msg.trackId);
      broadcast({ type: 'REMOVE_TRACK', trackId: msg.trackId, from: from.id }, null);
      break;
    }

    case 'UPDATE_TRACK': {
      const t = serverState.tracks.find(t => t.id === msg.trackId);
      if (t) Object.assign(t, msg.updates);
      broadcast({ type: 'UPDATE_TRACK', trackId: msg.trackId, updates: msg.updates, from: from.id }, ws);
      break;
    }

    case 'ADD_CLIP': {
      // Los clips de audio incluyen audioData (base64)
      // Los guardamos en el estado para que participantes futuros los reciban
      serverState.clips.push(msg.clip);
      // Reenviar a TODOS incluyendo al remitente (necesita confirmar el id)
      broadcast({ type: 'ADD_CLIP', clip: msg.clip, from: from.id }, null);
      console.log(`  [clip] ${from.name} añadió "${msg.clip.name}" (${msg.clip.type})`);
      break;
    }

    case 'REMOVE_CLIP': {
      serverState.clips = serverState.clips.filter(c => c.id !== msg.clipId);
      broadcast({ type: 'REMOVE_CLIP', clipId: msg.clipId, from: from.id }, null);
      break;
    }

    case 'MOVE_CLIP': {
      const c = serverState.clips.find(c => c.id === msg.clipId);
      if (c) c.startBeat = msg.startBeat;
      broadcast({ type: 'MOVE_CLIP', clipId: msg.clipId, startBeat: msg.startBeat, from: from.id }, ws);
      break;
    }

    case 'RESIZE_CLIP': {
      const c = serverState.clips.find(c => c.id === msg.clipId);
      if (c) c.durationBeats = msg.durationBeats;
      broadcast({ type: 'RESIZE_CLIP', clipId: msg.clipId, durationBeats: msg.durationBeats, from: from.id }, ws);
      break;
    }

    case 'SET_BPM': {
      serverState.bpm = msg.bpm;
      broadcast({ type: 'SET_BPM', bpm: msg.bpm, from: from.id }, ws);
      break;
    }

    case 'TRANSPORT': {
      // Sincronización de play/stop: opcional, algunos proyectos
      // prefieren que cada quien controle su reproducción
      broadcast({ type: 'TRANSPORT', action: msg.action, position: msg.position, from: from.id }, ws);
      break;
    }

    case 'SET_NAME': {
      const newName = String(msg.name || '').trim().slice(0, 20);
      if (newName) from.name = newName;
      broadcast({ type: 'CLIENT_UPDATED', client: { id: from.id, name: from.name, color: from.color } }, null);
      break;
    }

    case 'CURSOR': {
      // Posición del cursor en la línea temporal (en beats)
      // No guardamos en el estado — es información efímera
      broadcast({ type: 'CURSOR', beat: msg.beat, from: from.id, color: from.color }, ws);
      break;
    }

    default:
      console.warn(`Mensaje desconocido: ${msg.type}`);
  }
}

// ──────────────────────────────────────────────────────────
//  UTILIDADES DE COMUNICACIÓN
// ──────────────────────────────────────────────────────────

/**
 * send(): envía un mensaje JSON a un cliente específico.
 * Verifica que la conexión esté abierta antes de enviar.
 */
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * broadcast(): envía un mensaje a todos los clientes conectados.
 * Si `exclude` es un ws, ese cliente no recibe el mensaje.
 * Si `exclude` es null, todos reciben el mensaje.
 */
function broadcast(data, exclude) {
  const str = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    }
  }
}

// ──────────────────────────────────────────────────────────
//  ARRANQUE
// ──────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Secuenciador Polifónico Colectivo          ║
║   Servidor corriendo en puerto ${PORT}          ║
╠══════════════════════════════════════════════╣
║   Local:      http://localhost:${PORT}          ║
║   WebSocket:  ws://localhost:${PORT}            ║
╚══════════════════════════════════════════════╝
  `);
});
