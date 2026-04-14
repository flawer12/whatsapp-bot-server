/**
 * Servidor Express — Puente bot WhatsApp ↔ App React Native
 */

const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const qrcode    = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app  = express();
const PORT = process.env.PORT || 3001;

const DATA_DIR      = path.join(__dirname, 'data');
const PEDIDOS_FILE  = path.join(DATA_DIR, 'pedidos.json');
const CATALOGO_FILE = path.join(DATA_DIR, 'catalogo.json');
const SESIONES_FILE = path.join(DATA_DIR, 'sesiones.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function leerJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {}
  return fallback;
}
function guardarJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let pedidos  = leerJSON(PEDIDOS_FILE,  []);
let catalogo = leerJSON(CATALOGO_FILE, []);
let sesiones = leerJSON(SESIONES_FILE, {});
let clientes = [];

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function generarId(prefix = 'PED') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${code}`;
}

function guardarPedidos() { guardarJSON(PEDIDOS_FILE, pedidos); }

function broadcast(evento, datos) {
  const payload = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  clientes = clientes.filter(res => {
    try { res.write(payload); return true; }
    catch { return false; }
  });
}

// ── Obtener ruta de Chromium incluido en puppeteer ──
function getChromiumPath() {
  try {
    // puppeteer v21+ usa executablePath() directamente
    const puppeteer = require('puppeteer');
    const chromePath = puppeteer.executablePath();
    if (chromePath && fs.existsSync(chromePath)) {
      console.log(`✅ Chromium de puppeteer: ${chromePath}`);
      return chromePath;
    }
  } catch (e) {
    console.warn('puppeteer.executablePath() falló:', e.message);
  }

  // Rutas manuales de fallback
  const fallbacks = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
    '/root/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
    '/home/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
  ].filter(Boolean);

  for (const pattern of fallbacks) {
    if (!pattern.includes('*')) {
      if (fs.existsSync(pattern)) {
        console.log(`✅ Chromium en: ${pattern}`);
        return pattern;
      }
    } else {
      try {
        const { execSync } = require('child_process');
        const found = execSync(`ls ${pattern} 2>/dev/null | head -1`).toString().trim();
        if (found && fs.existsSync(found)) {
          console.log(`✅ Chromium glob: ${found}`);
          return found;
        }
      } catch {}
    }
  }

  console.warn('⚠️  No se encontró Chromium — bot WhatsApp desactivado');
  return null;
}

const CHROME_PATH = getChromiumPath();

const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: CHROME_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
    timeout: 60000,
  },
  restartOnAuthFail: true,
});

let botListo = false;

waClient.on('qr', qr => {
  console.log('\n📱 Escanea este QR con WhatsApp → Dispositivos vinculados → Vincular dispositivo:\n');
  qrcode.generate(qr, { small: true });
});

waClient.on('authenticated', () => console.log('🔐 Autenticado. Cargando...'));

waClient.on('ready', () => {
  botListo = true;
  console.log(`\n✅ Bot conectado! Número: ${waClient.info?.wid?.user}\n`);
});

waClient.on('auth_failure', msg => {
  botListo = false;
  console.error('❌ Error de autenticación:', msg);
});

waClient.on('disconnected', reason => {
  botListo = false;
  console.log('📴 Desconectado:', reason, '— reconectando en 5s...');
  setTimeout(() => waClient.initialize().catch(() => {}), 5000);
});

function menuPrincipal(nombre) {
  return (
    `Hola ${nombre || ''}! 👋 Bienvenido a nuestra tienda.\n\n` +
    `Elige una opción:\n` +
    `1️⃣  Ver catálogo\n` +
    `2️⃣  Hacer un pedido\n` +
    `3️⃣  Ver mi carrito\n` +
    `4️⃣  Confirmar pedido\n` +
    `5️⃣  Cancelar / Limpiar\n\n` +
    `Escribe el número o la palabra (ej: *catalogo*, *pedir*, *carrito*)\n` +
    `o escribe *hola* para volver al menú.`
  );
}

function textoCatalogo() {
  if (catalogo.length === 0) return '📦 El catálogo está vacío por ahora.';
  let txt = '📋 *Catálogo disponible:*\n\n';
  catalogo.forEach((p, i) => {
    txt += `*${i + 1}. ${p.nombre}*\n`;
    txt += `   💰 RD$${Number(p.precio).toLocaleString('es-DO')}\n`;
    if (p.categoria) txt += `   🏷️ ${p.categoria}\n`;
    txt += `   📦 Stock: ${p.cantidad} ${p.unidad || 'uds'}\n\n`;
  });
  txt += `Para pedir: *pedir [nombre del producto]*`;
  return txt;
}

function buscarProducto(texto) {
  const q = texto.toLowerCase().trim();
  return catalogo.filter(p =>
    p.nombre.toLowerCase().includes(q) ||
    (p.categoria || '').toLowerCase().includes(q)
  );
}

function getSesion(telefono) {
  if (!sesiones[telefono]) sesiones[telefono] = { paso: 'menu', carrito: [], nombre: '' };
  return sesiones[telefono];
}

async function enviarImagenBase64(to, base64DataUri, caption) {
  try {
    const match = base64DataUri.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!match) return false;
    const [, mimetype, data] = match;
    const media = new MessageMedia(mimetype, data);
    await waClient.sendMessage(to, media, { caption });
    return true;
  } catch (e) {
    console.error('Error enviando imagen:', e.message);
    return false;
  }
}

waClient.on('message', async msg => {
  if (msg.isGroupMsg || msg.type !== 'chat') return;
  const telefono = msg.from.replace('@c.us', '').replace(/^1/, '');
  const texto    = msg.body.trim();
  const sesion   = getSesion(telefono);
  const lower    = texto.toLowerCase();

  console.log(`📨 [${telefono}]: ${texto}`);

  if (['hola','menu','menú','inicio','hi','buenas','0'].includes(lower)) {
    sesion.paso = 'menu';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from, menuPrincipal(sesion.nombre));
  }

  if (['cancelar','limpiar','5'].includes(lower)) {
    sesion.carrito = []; sesion.paso = 'menu';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from, '🗑️ Carrito limpiado. Escribe *hola* para volver.');
  }

  if (['catalogo','catálogo','1','productos','ver catalogo'].includes(lower)) {
    sesion.paso = 'catalogo';
    guardarJSON(SESIONES_FILE, sesiones);
    await waClient.sendMessage(msg.from, textoCatalogo());
    for (const prod of catalogo) {
      if (prod.imagenB64) {
        await enviarImagenBase64(msg.from, prod.imagenB64,
          `*${prod.nombre}* — RD$${Number(prod.precio).toLocaleString('es-DO')}`);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return;
  }

  if (['pedir','pedido','2','ordenar','hacer pedido'].includes(lower)) {
    sesion.paso = 'esperando_producto';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from, `🛒 ¿Qué producto quieres?\n\n${textoCatalogo()}`);
  }

  if (sesion.paso === 'esperando_nombre') {
    sesion.nombre = texto; sesion.paso = 'menu';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from, menuPrincipal(texto));
  }

  if (sesion.paso === 'esperando_producto' || lower.startsWith('pedir ')) {
    const termino    = lower.startsWith('pedir ') ? texto.slice(6) : texto;
    const resultados = buscarProducto(termino);
    if (resultados.length === 0)
      return waClient.sendMessage(msg.from, `😕 No encontré "${termino}".\n\n${textoCatalogo()}`);
    const prod = resultados[0];
    const item = sesion.carrito.find(c => c.id === prod.id);
    if (item) item.cantidad += 1;
    else sesion.carrito.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, cantidad: 1 });
    sesion.paso = 'en_carrito';
    guardarJSON(SESIONES_FILE, sesiones);
    if (prod.imagenB64)
      await enviarImagenBase64(msg.from, prod.imagenB64,
        `*${prod.nombre}* — RD$${Number(prod.precio).toLocaleString('es-DO')}`);
    const total = sesion.carrito.reduce((s, c) => s + c.precio * c.cantidad, 0);
    return waClient.sendMessage(msg.from,
      `✅ *${prod.nombre}* agregado!\n💰 RD$${Number(prod.precio).toLocaleString('es-DO')}\n\n` +
      `🛒 Carrito:\n${sesion.carrito.map(c => `  • ${c.cantidad}× ${c.nombre}`).join('\n')}\n` +
      `📊 Total: *RD$${total.toLocaleString('es-DO')}*\n\n` +
      `Escribe *pedir [producto]* para más o *confirmar* para finalizar`);
  }

  if (['carrito','ver carrito','3'].includes(lower)) {
    if (sesion.carrito.length === 0)
      return waClient.sendMessage(msg.from, '🛒 Tu carrito está vacío.');
    const total = sesion.carrito.reduce((s, c) => s + c.precio * c.cantidad, 0);
    let resp = `🛒 *Tu carrito:*\n\n`;
    sesion.carrito.forEach(c => { resp += `• ${c.cantidad}× ${c.nombre} — RD$${(c.precio*c.cantidad).toLocaleString('es-DO')}\n`; });
    resp += `\n💰 *Total: RD$${total.toLocaleString('es-DO')}*\n\nEscribe *confirmar* o *limpiar*`;
    return waClient.sendMessage(msg.from, resp);
  }

  if (['confirmar','4','si','sí','ok','dale','confirmo'].includes(lower)) {
    if (sesion.carrito.length === 0)
      return waClient.sendMessage(msg.from, '🛒 Tu carrito está vacío.');
    const total  = sesion.carrito.reduce((s, c) => s + c.precio * c.cantidad, 0);
    const nombre = sesion.nombre || `Cliente WA ${telefono.slice(-4)}`;
    const pedido = {
      id:              generarId('PED'),
      clienteNombre:   nombre,
      clienteTelefono: telefono,
      items:           sesion.carrito.map(c => ({ nombre: c.nombre, cantidad: c.cantidad, precio: c.precio })),
      total,
      estado:          'pendiente',
      fecha:           new Date().toISOString(),
      notas:           'Pedido vía WhatsApp',
    };
    pedidos.unshift(pedido);
    guardarPedidos();
    broadcast('nuevo_pedido', pedido);
    sesion.carrito = []; sesion.paso = 'menu';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from,
      `✅ *¡Pedido confirmado!*\n\n🆔 *${pedido.id}*\n💰 RD$${total.toLocaleString('es-DO')}\n\n⏳ Te confirmamos pronto.`);
  }

  if (!sesion.nombre && sesion.paso === 'menu') {
    sesion.paso = 'esperando_nombre';
    guardarJSON(SESIONES_FILE, sesiones);
    return waClient.sendMessage(msg.from, `👋 Hola! ¿Cómo te llamas?`);
  }

  return waClient.sendMessage(msg.from, `No entendí 😊 Escribe *hola* para el menú.`);
});

console.log('\n⏳ Iniciando bot de WhatsApp...\n');
waClient.initialize().catch(err => {
  console.error('⚠️  Error al iniciar WhatsApp:', err.message);
  console.log('El servidor REST sigue activo sin WhatsApp.\n');
});

// ── REST API ──
app.get('/health', (req, res) => res.json({
  ok:         true,
  pedidos:    pedidos.length,
  catalogo:   catalogo.length,
  conectados: clientes.length,
  chromium:   CHROME_PATH || 'no encontrado',
  botWA:      botListo ? `✅ ${waClient.info?.wid?.user}` : '⏳ Conectando...',
  hora:       new Date().toLocaleTimeString('es-DO'),
}));

app.get('/catalogo', (req, res) => res.json(catalogo));

app.post('/catalogo', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Se espera un array' });
  catalogo = items
    .filter(p => p.nombre && p.precio != null)
    .map((p, i) => ({
      id:        p.id || `p${i + 1}`,
      nombre:    p.nombre,
      precio:    Number(p.precio),
      cantidad:  p.cantidad ?? 0,
      categoria: p.categoria || '',
      unidad:    p.unidad || 'uds',
      imagenB64: p.imagenB64 || null,
    }));
  guardarJSON(CATALOGO_FILE, catalogo);
  res.json({ ok: true, total: catalogo.length });
});

app.get('/pedidos', (req, res) => res.json(pedidos));

app.get('/pedidos/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: sync\ndata: ${JSON.stringify(pedidos)}\n\n`);
  clientes.push(res);
  req.on('close', () => { clientes = clientes.filter(c => c !== res); });
});

app.post('/pedido', (req, res) => {
  const datos = req.body;
  if (!datos.clienteNombre || !Array.isArray(datos.items))
    return res.status(400).json({ error: 'Faltan campos' });
  const pedido = {
    id:              generarId('PED'),
    clienteNombre:   datos.clienteNombre,
    clienteTelefono: datos.clienteTelefono || '',
    items:           datos.items,
    total:           datos.total ?? datos.items.reduce((s, i) => s + i.precio * i.cantidad, 0),
    estado:          'pendiente',
    fecha:           new Date().toISOString(),
    notas:           datos.notas || '',
  };
  pedidos.unshift(pedido);
  guardarPedidos();
  broadcast('nuevo_pedido', pedido);
  res.status(201).json({ ok: true, pedido });
});

app.patch('/pedido/:id/estado', (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const validos = ['pendiente','confirmado','entregado','cancelado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: 'No encontrado' });
  pedido.estado = estado;
  guardarPedidos();
  broadcast('estado_actualizado', { id, estado });
  if (pedido.clienteTelefono && botListo) {
    const num  = `${pedido.clienteTelefono}@c.us`;
    const msgs = {
      confirmado: `✅ Tu pedido *${id}* fue *confirmado*. 🚚`,
      entregado:  `🎉 Tu pedido *${id}* fue *entregado*. ¡Gracias! ⭐`,
      cancelado:  `❌ Tu pedido *${id}* fue cancelado.`,
    };
    if (msgs[estado]) waClient.sendMessage(num, msgs[estado]).catch(() => {});
  }
  res.json({ ok: true, pedido });
});

app.delete('/pedido/:id', (req, res) => {
  const { id } = req.params;
  pedidos = pedidos.filter(p => p.id !== id);
  guardarPedidos();
  broadcast('pedido_eliminado', { id });
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
