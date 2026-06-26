/**
 * server.js — Servidor principal del juego de congreso
 * Stack: Node.js + Express + Socket.io
 * Dinámica: botón de cupo → cola de respuesta → puntos por velocidad
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

// CONFIG
const PORT = process.env.PORT || 3000;
const MAX_CUPOS = 20;
const TIEMPO_RESPUESTA = 15;

// MIDDLEWARE (si usas frontend estático)
app.use(express.static(path.join(__dirname, "public")));

// RUTAS (ajusta si tus archivos están en otra carpeta)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/host", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/pantalla", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pantalla.html"));
});

// SOCKET.IO
io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});



// ─── Estado Global ────────────────────────────────────────────────────────────
let estado = {
  fase: "lobby",          // "lobby" | "boton" | "respondiendo" | "resultado" | "fin"
  preguntaActual: null,   // { id, texto, opciones: [{letra,texto}], correcta: "A"|"B"|"C"|"D", puntosTotales }
  preguntaIndex: 0,
  preguntas: [],          // banco de preguntas cargadas por el host
  cupos: [],              // [{ alias, socketId, timestamp }] — orden de llegada
  cuposSet: new Set(),    // para lookup O(1)
  respondiendo: null,     // { alias, socketId } — quien está respondiendo ahora
  cola: [],               // cola de quienes presionaron pero esperan turno
  respuestasEnPregunta: new Set(), // socketIds que ya respondieron (bien o mal) en esta pregunta
  timerHandle: null,
  timerInicio: null,
  puntajes: {},           // { socketId: { alias, puntos, respuestasCorrectas } }
  historial: [],          // preguntas anteriores con resultados
};

function resetPregunta() {
  if (estado.timerHandle) clearTimeout(estado.timerHandle);
  estado.cupos = [];
  estado.cuposSet.clear();
  estado.respondiendo = null;
  estado.cola = [];
  estado.respuestasEnPregunta.clear();
  estado.timerHandle = null;
  estado.timerInicio = null;
}

function snapPuntajes() {
  return Object.values(estado.puntajes)
    .sort((a, b) => b.puntos - a.puntos)
    .map((p, i) => ({ ...p, posicion: i + 1 }));
}

// ─── Temporizador de respuesta ────────────────────────────────────────────────
function iniciarTimerRespuesta(socketId) {
  if (estado.timerHandle) clearTimeout(estado.timerHandle);
  estado.timerInicio = Date.now();

  estado.timerHandle = setTimeout(() => {
    // Se acabó el tiempo — pasar al siguiente en cola
    console.log(`[⏰] Tiempo agotado para ${socketId}`);
    io.emit("tiempo_agotado", { alias: estado.respondiendo?.alias });
    pasarAlSiguiente();
  }, TIEMPO_RESPUESTA * 1000);
}

function pasarAlSiguiente() {
  if (estado.timerHandle) clearTimeout(estado.timerHandle);
  estado.timerHandle = null;

  if (estado.cola.length > 0) {
    const siguiente = estado.cola.shift();
    // verificar que siga conectado
    const socketSiguiente = io.sockets.sockets.get(siguiente.socketId);
    if (!socketSiguiente) {
      pasarAlSiguiente(); // skip si se desconectó
      return;
    }
    estado.respondiendo = siguiente;
    console.log(`[→] Turno de: ${siguiente.alias}`);

    io.emit("turno_respondiendo", {
      alias: siguiente.alias,
      socketId: siguiente.socketId,
    });
    socketSiguiente.emit("tu_turno", {
      pregunta: estado.preguntaActual,
      tiempo: TIEMPO_RESPUESTA,
    });
    iniciarTimerRespuesta(siguiente.socketId);
  } else {
    // Cola vacía — nadie más puede responder esta pregunta
    estado.respondiendo = null;
    estado.fase = "resultado";
    console.log("[!] Cola vacía — mostrando resultado");
    io.emit("mostrar_resultado", {
      pregunta: estado.preguntaActual,
      puntajes: snapPuntajes(),
      motivo: "sin_respuestas",
    });
  }
}

// ─── Servir archivos estáticos ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/pantalla", (req, res) => res.sendFile(path.join(__dirname, "public", "pantalla.html")));

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Conexión: ${socket.id}`);

  // Sincronizar estado al conectarse
  socket.emit("estado_actual", {
    fase: estado.fase,
    // Incluimos opciones para que pantalla.html pueda rehidratarse al reconectar
    // durante una pregunta activa. correcta nunca se expone al cliente.
    preguntaActual: estado.fase === "boton"
      ? { texto: estado.preguntaActual?.texto, opciones: estado.preguntaActual?.opciones }
      : null,
    // Quién está respondiendo en este momento (útil si pantalla reconecta mid-turno)
    respondiendo: estado.respondiendo ? { alias: estado.respondiendo.alias } : null,
    cupos: { total: estado.cupos.length, max: MAX_CUPOS },
    puntajes: snapPuntajes(),
    totalPreguntas: estado.preguntas.length,
    preguntaIndex: estado.preguntaIndex,
  });

  // ── Jugador: unirse ────────────────────────────────────────────────────────
  socket.on("unirse", ({ alias }) => {
    const aliasSanitizado = String(alias || "").trim().slice(0, 30) || `J-${socket.id.slice(0, 4)}`;
    socket.alias = aliasSanitizado;

    if (!estado.puntajes[socket.id]) {
      estado.puntajes[socket.id] = { alias: aliasSanitizado, puntos: 0, respuestasCorrectas: 0, socketId: socket.id };
    }

    console.log(`[~] "${aliasSanitizado}" se unió`);
    socket.emit("unido", {
      alias: aliasSanitizado,
      fase: estado.fase,
      puntajes: snapPuntajes(),
    });

    io.emit("jugador_unido", { alias: aliasSanitizado, total: Object.keys(estado.puntajes).length });
  });

  // ── Jugador: presionar botón para ganar cupo ───────────────────────────────
  socket.on("presionar_boton", () => {
    if (estado.fase !== "boton") {
      socket.emit("resultado_boton", { exito: false, razon: "El botón no está activo." });
      return;
    }
    if (estado.cuposSet.has(socket.id)) {
      socket.emit("resultado_boton", { exito: false, razon: "Ya estás en la cola." });
      return;
    }
    if (estado.respuestasEnPregunta.has(socket.id)) {
      socket.emit("resultado_boton", { exito: false, razon: "Ya respondiste esta pregunta." });
      return;
    }
    if (estado.cupos.length >= MAX_CUPOS) {
      socket.emit("resultado_boton", { exito: false, razon: "Los cupos están llenos." });
      return;
    }

    const alias = socket.alias || `J-${socket.id.slice(0, 4)}`;
    const entrada = { alias, socketId: socket.id, timestamp: Date.now() };
    estado.cupos.push(entrada);
    estado.cuposSet.add(socket.id);

    const posicion = estado.cupos.length;
    console.log(`[★] Cupo #${posicion}: "${alias}"`);

    socket.emit("resultado_boton", { exito: true, posicion });
    io.emit("actualizar_cupos", { total: estado.cupos.length, max: MAX_CUPOS });

    // Si es el primero en la cola y nadie está respondiendo → darle el turno
    if (posicion === 1 && !estado.respondiendo) {
      estado.cola.push(entrada);
      pasarAlSiguiente();
    } else {
      estado.cola.push(entrada);
    }
  });

  // ── Jugador: enviar respuesta ──────────────────────────────────────────────
  socket.on("responder", ({ letra }) => {
    if (estado.fase !== "boton") {
      socket.emit("resultado_respuesta", { exito: false, razon: "Fuera de fase." });
      return;
    }
    if (!estado.respondiendo || estado.respondiendo.socketId !== socket.id) {
      socket.emit("resultado_respuesta", { exito: false, razon: "No es tu turno." });
      return;
    }

    const correcta = estado.preguntaActual.correcta;
    const esCorrecta = letra === correcta;

    // Marcar que este socket ya respondió
    estado.respuestasEnPregunta.add(socket.id);
    if (estado.timerHandle) clearTimeout(estado.timerHandle);

    let puntosGanados = 0;
    if (esCorrecta) {
      // Puntaje según velocidad: más rápido = más puntos
      const tiempoUsado = (Date.now() - estado.timerInicio) / 1000;
      const factor = Math.max(0, (TIEMPO_RESPUESTA - tiempoUsado) / TIEMPO_RESPUESTA);
      puntosGanados = Math.round(1000 * factor) + 500; // base 500 + bonus velocidad

      const reg = estado.puntajes[socket.id];
      if (reg) {
        reg.puntos += puntosGanados;
        reg.respuestasCorrectas += 1;
      }

      console.log(`[✓] "${socket.alias}" respondió correcto. +${puntosGanados} pts`);

      // Respuesta correcta → mostrar resultado
      estado.fase = "resultado";
      io.emit("mostrar_resultado", {
        correcto: true,
        alias: socket.alias,
        letra,
        correcta,
        puntosGanados,
        pregunta: estado.preguntaActual,
        puntajes: snapPuntajes(),
      });

    } else {
      console.log(`[✗] "${socket.alias}" respondió mal (${letra}, correcta: ${correcta})`);

      socket.emit("resultado_respuesta", {
        correcto: false,
        letra,
        correcta: null, // no revelar la correcta todavía
      });

      // Emitir a todos que falló (sin revelar respuesta)
      io.emit("respuesta_incorrecta", {
        alias: socket.alias,
        letra,
      });

      // Pasar al siguiente en la cola
      estado.respondiendo = null;
      pasarAlSiguiente();
    }
  });

  // ── HOST: cargar pregunta nueva ────────────────────────────────────────────
  socket.on("host_cargar_pregunta", ({ texto, opciones, correcta, index }) => {
    // opciones: [{ letra: "A", texto: "..." }, ...]
    const pregunta = {
      id: Date.now(),
      texto,
      opciones,
      correcta,
      puntosTotales: 1000,
    };

    if (index !== undefined && index < estado.preguntas.length) {
      estado.preguntas[index] = pregunta;
    } else {
      estado.preguntas.push(pregunta);
    }

    console.log(`[Q] Pregunta cargada: "${texto}"`);
    socket.emit("pregunta_guardada", { total: estado.preguntas.length });
  });

  // ── HOST: iniciar fase de botón ────────────────────────────────────────────
  socket.on("host_iniciar_boton", ({ preguntaId }) => {
    // Buscar la pregunta por id, o tomar la siguiente
    let pregunta;
    if (preguntaId) {
      pregunta = estado.preguntas.find(p => p.id === preguntaId);
    } else {
      pregunta = estado.preguntas[estado.preguntaIndex] || null;
    }

    if (!pregunta) {
      socket.emit("error_host", { msg: "No hay pregunta disponible. Cargá una primero." });
      return;
    }

    resetPregunta();
    estado.preguntaActual = pregunta;
    estado.fase = "boton";

    console.log(`[!] Fase BOTÓN iniciada: "${pregunta.texto}"`);

    // A jugadores y pantalla: solo el texto de la pregunta (sin revelar respuesta)
    io.emit("fase_boton", {
      pregunta: {
        texto: pregunta.texto,
        opciones: pregunta.opciones,
      },
      max: MAX_CUPOS,
    });
  });

  // ── HOST: pasar a siguiente pregunta ──────────────────────────────────────
  socket.on("host_siguiente_pregunta", () => {
    estado.preguntaIndex = (estado.preguntaIndex + 1) % Math.max(1, estado.preguntas.length);
    resetPregunta();
    estado.fase = "lobby";
    io.emit("volver_lobby", { puntajes: snapPuntajes(), preguntaIndex: estado.preguntaIndex });
  });

  // ── HOST: reiniciar todo ───────────────────────────────────────────────────
  socket.on("host_reiniciar", () => {
    resetPregunta();
    estado.fase = "lobby";
    estado.preguntaActual = null;
    estado.preguntaIndex = 0;
    estado.puntajes = {};
    estado.historial = [];
    console.log("[↺] Juego reiniciado");
    io.emit("juego_reiniciado");
  });

  // ── HOST: eliminar pregunta ────────────────────────────────────────────────
  socket.on("host_eliminar_pregunta", ({ index }) => {
    if (index >= 0 && index < estado.preguntas.length) {
      estado.preguntas.splice(index, 1);
      socket.emit("preguntas_actualizadas", { preguntas: estado.preguntas.map(p => ({ id: p.id, texto: p.texto })) });
    }
  });

  // ── HOST: pedir lista de preguntas ────────────────────────────────────────
  socket.on("host_pedir_preguntas", () => {
    socket.emit("lista_preguntas", {
      preguntas: estado.preguntas,
      preguntaIndex: estado.preguntaIndex,
    });
  });

  // ── Desconexión ────────────────────────────────────────────────────────────
  socket.on("disconnect", (razon) => {
    console.log(`[-] Desconexión: ${socket.id} (${razon})`);

    // Si era quien estaba respondiendo → pasar al siguiente
    if (estado.respondiendo?.socketId === socket.id) {
      estado.respondiendo = null;
      pasarAlSiguiente();
    }
  });
});

// ─── Arrancar servidor ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`✅ Servidor en puerto ${PORT}`);
  console.log(`   Jugadores:  /`);
  console.log(`   Host:       /host`);
  console.log(`   Pantalla:   /pantalla`);
});
