# ∿ Secuenciador Polifónico Colectivo

Un secuenciador de audio en red donde múltiples personas pueden subir,
superponer y modificar fragmentos de audio sobre una línea temporal común.

## Estructura de archivos

```
secuenciador-polifonico/
├── server.js          ← servidor Node.js (WebSocket + HTTP)
├── secuenciador.html  ← cliente web (se abre en el navegador)
├── package.json       ← dependencias
└── README.md
```

---

## Correr localmente

**Requisitos:** Node.js 18 o superior

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar el servidor
npm start
```

El servidor arranca en http://localhost:8080

Cada participante abre esa URL en su navegador. En el diálogo de conexión:
- Escribe tu nombre
- Deja la URL como `ws://localhost:8080`
- Clic en **CONECTAR Y ENTRAR**

Para prueba local con varias personas, todas deben estar en la **misma red**
y usar la IP local de la máquina que corre el servidor (ej. `ws://192.168.1.5:8080`).

---

## Hospedar en internet (gratis)

Para que personas en distintos lugares puedan colaborar, necesitas
subir el servidor a un servicio de hosting con soporte WebSocket.

### Railway.app (recomendado, más simple)

1. Crea cuenta en [railway.app](https://railway.app)
2. Nuevo proyecto → **Deploy from GitHub repo**
3. Conecta este repositorio
4. Railway detecta `package.json` y corre `npm start` automáticamente
5. En la pestaña **Settings → Networking**, genera un dominio público
6. La URL del WebSocket será `wss://tu-app.railway.app`

### Render.com

1. Crea cuenta en [render.com](https://render.com)
2. New → **Web Service** → conecta el repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. La URL será `wss://tu-app.onrender.com`

### Fly.io

```bash
# Instalar flyctl
brew install flyctl  # macOS

# Desplegar
fly launch
fly deploy
```

---

## Uso

### Botones principales

| Acción | Descripción |
|--------|-------------|
| **+ PISTA** | Crea una pista nueva con sintetizador |
| **↑ AUDIO** | Importa archivos de audio (.mp3, .wav, .ogg, etc.) |
| **▶ PLAY** | Reproduce / pausa (también con `Espacio`) |
| **■** | Detiene y vuelve al inicio (`Esc`) |
| **LOOP ○** | Activa reproducción cíclica |

### Gestos en la línea temporal

- **Clic en fila vacía** → añade un clip de síntesis
- **Arrastrar clip** → mover en el tiempo
- **Arrastrar borde derecho** → cambiar duración
- **Doble clic en clip** → eliminar

### Indicadores de red

- **Punto de color** en la cabecera: gris=desconectado, amarillo=conectando, verde=conectado
- **Avatares** de los participantes en la cabecera
- **Cursores de colores** en la línea temporal: posición de reproducción de cada participante
- **Notificaciones** en la esquina inferior derecha: entradas, salidas, uploads

---

## Límites técnicos

| Parámetro | Límite |
|-----------|--------|
| Tamaño máximo de archivo de audio | 20 MB |
| Pistas simultáneas | 24 |
| Participantes simultáneos | sin límite (depende del servidor) |
| Formatos de audio | .mp3, .wav, .ogg, .flac, .aac |

---

## Arquitectura técnica

```
Participante A                  Servidor Node.js              Participante B
(navegador)                     (WebSocket)                   (navegador)
    │                               │                               │
    │── ADD_CLIP (audio base64) ──→ │                               │
    │                               │── ADD_CLIP (audio base64) ──→ │
    │                               │── ADD_CLIP ────────────────→ │ (a todos)
    │← ADD_CLIP (confirmado) ──────│                               │
    │                               │                               │
    │── MOVE_CLIP ───────────────→ │                               │
    │                               │── MOVE_CLIP ───────────────→ │
    │                               │                               │
    │── CURSOR (beat) ───────────→ │                               │
    │                               │── CURSOR ──────────────────→ │
```

El servidor es la **fuente de verdad**: ningún cliente aplica cambios
antes de que el servidor los confirme y redistribuya. Esto garantiza
que todos los participantes estén siempre sincronizados.

---

## Extender el proyecto

Algunos caminos posibles:

- **Grabar desde micrófono**: `Tone.UserMedia` + `Tone.Recorder` → base64 → servidor
- **Efectos por pista**: `Tone.Reverb`, `Tone.Delay`, etc. antes del `Channel`
- **Exportar mezcla**: `Tone.Offline()` para renderizar a WAV sin reproducción
- **Guardar sesión**: serializar `serverState` a JSON y guardarlo en disco
- **Sincronizar play/stop**: hacer que un participante pueda iniciar la reproducción para todos
- **Chat de texto**: añadir un tipo de mensaje `CHAT` y mostrar un panel lateral
