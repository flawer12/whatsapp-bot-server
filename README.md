# WhatsApp Bot Server 🤖

Servidor Express + Bot de WhatsApp para gestión de ventas locales.

## Deploy en Render

1. Conecta este repo en [render.com](https://render.com)
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Revisa los **Logs** para escanear el QR de WhatsApp

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servidor y bot |
| GET | `/catalogo` | Ver catálogo |
| POST | `/catalogo` | Actualizar catálogo desde la app |
| GET | `/pedidos` | Listar pedidos |
| POST | `/pedido` | Crear pedido |
| PATCH | `/pedido/:id/estado` | Cambiar estado |
| DELETE | `/pedido/:id` | Eliminar pedido |
| GET | `/pedidos/stream` | SSE en tiempo real |
