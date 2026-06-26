/**
 * server.js — Servidor principal del juego de congreso
 * Stack: Node.js + Express (archivos estáticos) + Socket.io (tiempo real)
 * Compatible con Render.com y cualquier host que use variables de entorno.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

// ─── Inicialización ───────────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  // Aumentar el tiempo de ping para conexiones móviles inestables
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;
const MAX_GANADORES = 20;

// ─── Estado Global del Juego ──────────────────────────────────────────────────
// Toda la lógica de estado vive aquí en memoria.
let estado = {
  ronda: "esperando", // "esperando" | "activa" | "terminada"
  ganadores: [],      // [{ alias, socketId, posicion }]
  ganadoresSet: new Set(), // Set de socketIds para búsqueda O(1) de duplicados
};

// ─── Servir Archivos Estáticos ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Rutas explícitas por claridad
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));

// ─── Lógica Socket.io ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Conexión: ${socket.id}`);

  // Al conectarse, enviar el estado actual al nuevo cliente para sincronización
  socket.emit("estado_actual", {
    ronda: estado.ronda,
    ganadores: estado.ganadores,
  });

  // ── Evento: Jugador se une con alias ────────────────────────────────────────
  socket.on("unirse", ({ alias }) => {
    // Sanitizar alias: eliminar espacios extra, limitar longitud
    const aliasSanitizado = String(alias || "")
      .trim()
      .slice(0, 30) || `Jugador-${socket.id.slice(0, 4)}`;

    // Guardar alias en el socket para recuperarlo después
    socket.alias = aliasSanitizado;
    console.log(`[~] ${socket.id} se unió como "${aliasSanitizado}"`);

    // Confirmar al jugador su ingreso exitoso
    socket.emit("unido", {
      alias: aliasSanitizado,
      ronda: estado.ronda,
      ganadores: estado.ganadores,
    });
  });

  // ── Evento: Host inicia la ronda ────────────────────────────────────────────
  socket.on("iniciar_ronda", () => {
    // Resetear estado para nueva ronda
    estado.ronda = "activa";
    estado.ganadores = [];
    estado.ganadoresSet.clear();

    console.log("[!] Ronda INICIADA por el host");

    // Notificar a TODOS los clientes (jugadores + proyector)
    io.emit("ronda_iniciada");
  });

  // ── Evento: Jugador presiona el botón ───────────────────────────────────────
  socket.on("presionar_boton", () => {
    // ① Guardia: solo acepta si la ronda está activa
    if (estado.ronda !== "activa") {
      socket.emit("resultado_boton", {
        exito: false,
        razon: "La ronda no está activa.",
      });
      return;
    }

    // ② Guardia: evitar duplicados del mismo socket
    if (estado.ganadoresSet.has(socket.id)) {
      socket.emit("resultado_boton", {
        exito: false,
        razon: "Ya fuiste registrado.",
      });
      return;
    }

    // ③ Guardia: ya tenemos los 20 ganadores
    if (estado.ganadores.length >= MAX_GANADORES) {
      estado.ronda = "terminada";
      socket.emit("resultado_boton", {
        exito: false,
        razon: "Los 20 cupos ya fueron llenados.",
      });
      return;
    }

    // ✅ Registrar ganador
    const posicion = estado.ganadores.length + 1;
    const alias = socket.alias || `Jugador-${socket.id.slice(0, 4)}`;
    const ganador = { alias, socketId: socket.id, posicion };

    estado.ganadores.push(ganador);
    estado.ganadoresSet.add(socket.id);

    console.log(`[★] Posición #${posicion}: "${alias}" (${socket.id})`);

    // Confirmar al jugador que ganó un cupo
    socket.emit("resultado_boton", {
      exito: true,
      posicion,
      alias,
    });

    // Actualizar leaderboard en todos los clientes (jugadores + proyector)
    io.emit("actualizar_ganadores", {
      ganadores: estado.ganadores,
      total: estado.ganadores.length,
    });

    // Si llenamos los 20, cerrar la ronda automáticamente
    if (estado.ganadores.length >= MAX_GANADORES) {
      estado.ronda = "terminada";
      console.log("[✓] Ronda TERMINADA: 20 ganadores registrados.");
      io.emit("ronda_terminada", { ganadores: estado.ganadores });
    }
  });

  // ── Evento: Host reinicia todo ──────────────────────────────────────────────
  socket.on("reiniciar_todo", () => {
    estado.ronda = "esperando";
    estado.ganadores = [];
    estado.ganadoresSet.clear();

    console.log("[↺] Juego REINICIADO por el host");

    // Notificar a todos los clientes para que vuelvan al estado inicial
    io.emit("juego_reiniciado");
  });

  // ── Desconexión ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (razon) => {
    console.log(`[-] Desconexión: ${socket.id} (${razon})`);
    // No se elimina al ganador del leaderboard si ya ganó:
    // el registro es permanente para esa ronda.
  });
});

// ─── Arrancar Servidor ────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Host:        http://localhost:${PORT}/host`);
  console.log(`   Participante: http://localhost:${PORT}/`);
});
