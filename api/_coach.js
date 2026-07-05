"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var coach_core_exports = {};
__export(coach_core_exports, {
  ANTHROPIC_API_URL: () => ANTHROPIC_API_URL,
  ANTHROPIC_VERSION: () => ANTHROPIC_VERSION,
  DEFAULT_SYSTEM_PROMPT: () => DEFAULT_SYSTEM_PROMPT,
  REGISTRAR_TOOL: () => REGISTRAR_TOOL,
  buildObjetivo: () => buildObjetivo,
  buildRequestBody: () => buildRequestBody,
  buildSystem: () => buildSystem,
  extractText: () => extractText,
  extractToolUses: () => extractToolUses,
  toolResultDesconocida: () => toolResultDesconocida,
  toolResultOk: () => toolResultOk,
  toolResultWipExceeded: () => toolResultWipExceeded,
  wipExceeded: () => wipExceeded
});
module.exports = __toCommonJS(coach_core_exports);
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_SYSTEM_PROMPT = `Eres el **Coach y Accountability Partner** de Martín dentro del ecosistema "The Game Of Time". Tu misión doble:
1) Ayudarlo a definir, comprometer y TERMINAR objetivos, atacando su problema real: se dispersa y no acaba lo que empieza.
2) Modelar el método en cada interacción, porque Martín quiere aprenderlo hasta dominarlo y convertirse él mismo en Coach/Accountability Partner de otros. Explica brevemente el "por qué" de lo que haces cuando aporte a su formación (marca eso con "🎓").
## La Meta (Filtro de la Meta)
La Meta de Martín: 1 millón de USD en 2 años resolviendo problemas de alto impacto mediante la gamificación del tiempo y del progreso humano. Todo objetivo debe pasar el Filtro: ¿este objetivo sirve a la Meta? Si no está claro, pregúntalo y ayúdalo a reformularlo o descartarlo. No aceptes objetivos por complacer.
## Principios que aplicas
- **Restricción inteligente:** una sola habilidad a la vez. Si el objetivo mezcla varias, ayúdalo a elegir UNA.
- **Regla 21x:** los avances se instalan como hábitos repetidos; el compromiso debe ser accionable y repetible, no vago.
- **Anti-dispersión (WIP):** hay un límite de objetivos ACTIVOS. Verás el estado actual más abajo. Si ya está en el límite, NO abras uno nuevo: hazlo elegir qué cerrar, pausar o priorizar primero. Este freno es el corazón de tu trabajo.
- **Siguiente paso mínimo:** todo termina en la acción más pequeña posible que se pueda hacer YA.
## El flujo de esta fase: DEFINIR + COMPROMETER
Conduce la conversación, un paso a la vez (no interrogues con listas):
1. Pregunta qué quiere lograr y por qué importa.
2. Pásalo por el Filtro de la Meta. Cuestiona con respeto si no encaja.
3. Reduce a UNA habilidad (restricción inteligente).
4. Verifica el WIP. Si está lleno, frénalo y haz que elija antes de continuar.
5. Descompón hasta el **siguiente paso mínimo** y un **compromiso concreto**: qué hará y cuándo (fecha/hora u ocasión clara).
6. Cuando el objetivo esté bien definido Y comprometido, llama a la herramienta \`registrar_objetivo\` con los campos. No la llames antes de tener claridad y compromiso reales.
## Estilo
Directo, cálido y exigente. Cero adulación ("excelente pregunta", "perfecto", etc.). Haces preguntas cortas y potentes. Una idea por turno. Si detectas dispersión o un compromiso difuso, lo nombras.`;
const REGISTRAR_TOOL = {
  name: "registrar_objetivo",
  description: "Registra un objetivo cuando ya está bien definido y comprometido: pasó el Filtro de la Meta, es una sola habilidad, tiene siguiente paso mínimo y un compromiso concreto (qué + cuándo). No la uses antes de tener eso.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      titulo: { type: "string", description: "Título breve y claro del objetivo." },
      por_que_meta: { type: "string", description: "Cómo este objetivo sirve a la Meta (1M en 2 años vía problemas de alto impacto)." },
      habilidad_unica: { type: "string", description: "La única habilidad que se va a desarrollar (restricción inteligente)." },
      siguiente_paso: { type: "string", description: "La acción más pequeña que se puede hacer ya." },
      compromiso_que: { type: "string", description: "Qué exactamente se compromete a hacer." },
      compromiso_cuando: { type: "string", description: "Cuándo lo hará: fecha, hora u ocasión concreta." }
    },
    required: ["titulo", "por_que_meta", "habilidad_unica", "siguiente_paso", "compromiso_que", "compromiso_cuando"]
  },
  strict: true
};
function buildSystem(systemPrompt, ctx) {
  const activos = ctx.activos;
  const lista = activos.length === 0 ? "Ninguno todavía." : activos.map((o, i) => `${i + 1}. ${o.titulo} — siguiente paso: ${o.siguientePaso}`).join("\n");
  const lleno = activos.length >= ctx.wipLimit;
  return `${systemPrompt}
## Estado actual (no lo inventes, es real)
- Objetivos ACTIVOS: ${activos.length} de ${ctx.wipLimit} (límite WIP).
- ${lleno ? "⚠️ WIP LLENO: no abras un objetivo nuevo hasta que se cierre, abandone o priorice uno existente." : "Hay cupo para definir un nuevo objetivo."}
- Lista de activos:
${lista}`;
}
function buildRequestBody(p) {
  return { model: p.model, max_tokens: p.maxTokens, system: p.system, tools: [REGISTRAR_TOOL], tool_choice: { type: "auto" }, messages: p.messages };
}
function extractText(content) {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
}
function extractToolUses(content) {
  return content.filter((b) => b.type === "tool_use");
}
function wipExceeded(activosCount, wipLimit) {
  return activosCount >= wipLimit;
}
function buildObjetivo(input) {
  const str = (k) => String(input[k] ?? "").trim();
  return {
    id: `obj-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
    titulo: str("titulo") || "Objetivo sin título",
    porQueMeta: str("por_que_meta"),
    habilidadUnica: str("habilidad_unica"),
    siguientePaso: str("siguiente_paso"),
    compromisoQue: str("compromiso_que"),
    compromisoCuando: str("compromiso_cuando"),
    estado: "activo",
    creado: new Date().toISOString()
  };
}
function toolResultOk(o) {
  return JSON.stringify({ ok: true, id: o.id, activos: o.activos, limite: o.limite, nota: o.nota });
}
function toolResultWipExceeded(activos, limite) {
  return JSON.stringify({ ok: false, error: "WIP_EXCEEDED", activos, limite, mensaje: "Límite de objetivos activos alcanzado. Debe cerrar, abandonar o priorizar uno antes de abrir otro." });
}
function toolResultDesconocida() {
  return JSON.stringify({ ok: false, error: "TOOL_DESCONOCIDA" });
}
