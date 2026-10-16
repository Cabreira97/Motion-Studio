import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "pt-BR" | "es";

export const LANGUAGES: Array<{ code: Lang; label: string }> = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "es", label: "Español" },
];

const en = {
  "lang.label": "Language",

  "nav.library": "Library",
  "nav.new": "New recording",

  "status.ffmpegReady": "ffmpeg ready",
  "status.ffmpegMissing": "ffmpeg missing",
  "status.ffmpegMissingTitle": "ffmpeg not found",

  "boot.loading": "Loading your library…",
  "common.retry": "Retry",

  "browser.notice":
    "Browser preview mode — recording UI works, but saving and exporting need the desktop app (pnpm first-run).",

  "record.title": "New recording",
  "record.desc":
    "Pick a source, optionally enable the microphone, then start. A timer stays visible while recording; the OS picker chooses the exact screen or window.",
  "record.start": "Start recording",
  "record.starting": "Starting…",

  "source.legend": "Source",
  "source.screen": "Entire screen",
  "source.screenHint": "Record a full display",
  "source.window": "Window",
  "source.windowHint": "Record a single application window",
  "source.region": "Region",
  "source.regionHint": "Record the screen, crop to a region",
  "source.mic": "Record microphone",
  "source.backend": "Capture backend: {backend}",
  "source.cursorOk": "Auto zoom will follow your cursor.",
  "source.cursorUnavailable":
    "Auto zoom cannot follow the cursor on this system, so recordings export without cursor zoom or highlight. Reason: {reason}",

  "kind.screen": "Screen",
  "kind.window": "Window",
  "kind.region": "Region",

  "library.emptyTitle": "No recordings yet",
  "library.emptyDesc": "Record your screen, and it will appear here for editing and export.",
  "library.title": "Your recordings",
  "library.meta": "Exports: {count} · {kind}",
  "library.unknownSize": "unknown size",
  "library.open": "Open",
  "library.delete": "Delete",

  "edit.back": "Library",
  "edit.previewPlaceholder": "Preview is available after recording in the desktop app.",
  "edit.summary": "Trim: {summary} · Output {width}×{height} @ {fps}fps",
  "edit.trim": "Trim",
  "edit.trimStart": "Start {time}",
  "edit.trimEnd": "End {time}",
  "edit.zoom": "Auto zoom",
  "edit.zoomFollow": "Follow the cursor with smooth zooms",
  "edit.zoomIntensity": "Intensity {percent}%",
  "edit.zoomHighlight": "Highlight the pointer",
  "edit.zoomKeyframes": "{count} zoom keyframes",
  "edit.crop": "Crop",
  "edit.cropField": "{field} {percent}%",
  "edit.framing": "Framing",
  "edit.padding": "Padding {px}px",
  "edit.radius": "Corner radius {px}px",
  "edit.background": "Background",
  "edit.clipLength": "Clip length {time}",
  "edit.resetCrop": "Reset crop",
  "edit.export": "Export",
  "edit.preset": "Format",
  "edit.exportVideo": "Export video",
  "edit.exportComplete": "Export complete",
  "edit.exportProgress": "Rendering {done} of {total}…",
  "edit.previousExports": "Previous exports",
  "edit.copy": "Copy",
  "edit.reveal": "Reveal",
  "edit.noSelectionTitle": "No recording selected",
  "edit.noSelectionDesc": "Pick a recording from the library to edit and export.",
  "edit.backToLibrary": "Back to library",

  "callouts.title": "Callouts",
  "callouts.add": "Add",
  "callouts.empty": "No callouts. Add timed labels or captions to the video.",
  "callouts.newText": "New callout",
  "callouts.placeholder": "Callout text",
  "callouts.at": "At {time}",
  "callouts.duration": "Duration {time}",
  "callouts.text": "Text",
  "callouts.box": "Box",
  "callouts.remove": "Remove",

  "rec.label": "REC",
  "rec.stop": "Stop",

  "error.captureUnsupported":
    "Screen capture is not available here. Use the desktop app (pnpm first-run) to record.",
  "error.exportNeedsDesktop":
    "Export runs through your local ffmpeg via the desktop app. Start it with pnpm first-run.",
  "error.micWarning": "The microphone was requested but no audio track was returned.",
  "error.revealFailed": "Could not open a file manager: {message}",
  "error.copyFailed": "Could not copy the path: {message}",
} as const;

export type TranslationKey = keyof typeof en;
type Dict = Record<TranslationKey, string>;
type Vars = Record<string, string | number>;

const ptBR: Dict = {
  "lang.label": "Idioma",

  "nav.library": "Biblioteca",
  "nav.new": "Nova gravação",

  "status.ffmpegReady": "ffmpeg pronto",
  "status.ffmpegMissing": "ffmpeg ausente",
  "status.ffmpegMissingTitle": "ffmpeg não encontrado",

  "boot.loading": "Carregando sua biblioteca…",
  "common.retry": "Tentar de novo",

  "browser.notice":
    "Modo de pré-visualização no navegador — a interface de gravação funciona, mas salvar e exportar precisam do aplicativo desktop (pnpm first-run).",

  "record.title": "Nova gravação",
  "record.desc":
    "Escolha uma fonte, ative o microfone se quiser e comece. Um cronômetro fica visível durante a gravação; o seletor do sistema escolhe a tela ou janela exata.",
  "record.start": "Iniciar gravação",
  "record.starting": "Iniciando…",

  "source.legend": "Fonte",
  "source.screen": "Tela inteira",
  "source.screenHint": "Gravar um monitor completo",
  "source.window": "Janela",
  "source.windowHint": "Gravar uma única janela de aplicativo",
  "source.region": "Região",
  "source.regionHint": "Gravar a tela e recortar uma região",
  "source.mic": "Gravar microfone",
  "source.backend": "Backend de captura: {backend}",
  "source.cursorOk": "O zoom automático vai acompanhar o seu cursor.",
  "source.cursorUnavailable":
    "O zoom automático não consegue acompanhar o cursor neste sistema, então as gravações são exportadas sem zoom nem destaque de cursor. Motivo: {reason}",

  "kind.screen": "Tela",
  "kind.window": "Janela",
  "kind.region": "Região",

  "library.emptyTitle": "Nenhuma gravação ainda",
  "library.emptyDesc": "Grave sua tela e ela aparecerá aqui para edição e exportação.",
  "library.title": "Suas gravações",
  "library.meta": "Exportações: {count} · {kind}",
  "library.unknownSize": "tamanho desconhecido",
  "library.open": "Abrir",
  "library.delete": "Excluir",

  "edit.back": "Biblioteca",
  "edit.previewPlaceholder": "A pré-visualização fica disponível após gravar no aplicativo desktop.",
  "edit.summary": "Corte: {summary} · Saída {width}×{height} @ {fps}fps",
  "edit.trim": "Corte",
  "edit.trimStart": "Início {time}",
  "edit.trimEnd": "Fim {time}",
  "edit.zoom": "Zoom automático",
  "edit.zoomFollow": "Acompanhar o cursor com zooms suaves",
  "edit.zoomIntensity": "Intensidade {percent}%",
  "edit.zoomHighlight": "Destacar o ponteiro",
  "edit.zoomKeyframes": "{count} keyframes de zoom",
  "edit.crop": "Recorte",
  "edit.cropField": "{field} {percent}%",
  "edit.framing": "Enquadramento",
  "edit.padding": "Margem {px}px",
  "edit.radius": "Cantos arredondados {px}px",
  "edit.background": "Fundo",
  "edit.clipLength": "Duração do clipe {time}",
  "edit.resetCrop": "Redefinir recorte",
  "edit.export": "Exportar",
  "edit.preset": "Formato",
  "edit.exportVideo": "Exportar vídeo",
  "edit.exportComplete": "Exportação concluída",
  "edit.exportProgress": "Renderizando {done} de {total}…",
  "edit.previousExports": "Exportações anteriores",
  "edit.copy": "Copiar",
  "edit.reveal": "Mostrar",
  "edit.noSelectionTitle": "Nenhuma gravação selecionada",
  "edit.noSelectionDesc": "Escolha uma gravação na biblioteca para editar e exportar.",
  "edit.backToLibrary": "Voltar para a biblioteca",

  "callouts.title": "Anotações",
  "callouts.add": "Adicionar",
  "callouts.empty": "Sem anotações. Adicione rótulos ou legendas temporizadas ao vídeo.",
  "callouts.newText": "Nova anotação",
  "callouts.placeholder": "Texto da anotação",
  "callouts.at": "Em {time}",
  "callouts.duration": "Duração {time}",
  "callouts.text": "Texto",
  "callouts.box": "Caixa",
  "callouts.remove": "Remover",

  "rec.label": "GRAV",
  "rec.stop": "Parar",

  "error.captureUnsupported":
    "A captura de tela não está disponível aqui. Use o aplicativo desktop (pnpm first-run) para gravar.",
  "error.exportNeedsDesktop":
    "A exportação usa o seu ffmpeg local através do aplicativo desktop. Inicie-o com pnpm first-run.",
  "error.micWarning": "O microfone foi solicitado, mas nenhuma faixa de áudio foi retornada.",
  "error.revealFailed": "Não foi possível abrir um gerenciador de arquivos: {message}",
  "error.copyFailed": "Não foi possível copiar o caminho: {message}",
};

const es: Dict = {
  "lang.label": "Idioma",

  "nav.library": "Biblioteca",
  "nav.new": "Nueva grabación",

  "status.ffmpegReady": "ffmpeg listo",
  "status.ffmpegMissing": "falta ffmpeg",
  "status.ffmpegMissingTitle": "ffmpeg no encontrado",

  "boot.loading": "Cargando tu biblioteca…",
  "common.retry": "Reintentar",

  "browser.notice":
    "Modo de vista previa en el navegador — la interfaz de grabación funciona, pero guardar y exportar necesitan la aplicación de escritorio (pnpm first-run).",

  "record.title": "Nueva grabación",
  "record.desc":
    "Elige una fuente, activa el micrófono si quieres y comienza. Un cronómetro permanece visible durante la grabación; el selector del sistema elige la pantalla o ventana exacta.",
  "record.start": "Iniciar grabación",
  "record.starting": "Iniciando…",

  "source.legend": "Fuente",
  "source.screen": "Pantalla completa",
  "source.screenHint": "Grabar una pantalla completa",
  "source.window": "Ventana",
  "source.windowHint": "Grabar una sola ventana de aplicación",
  "source.region": "Región",
  "source.regionHint": "Grabar la pantalla y recortar una región",
  "source.mic": "Grabar micrófono",
  "source.backend": "Backend de captura: {backend}",
  "source.cursorOk": "El zoom automático seguirá tu cursor.",
  "source.cursorUnavailable":
    "El zoom automático no puede seguir el cursor en este sistema, así que las grabaciones se exportan sin zoom ni resalte de cursor. Motivo: {reason}",

  "kind.screen": "Pantalla",
  "kind.window": "Ventana",
  "kind.region": "Región",

  "library.emptyTitle": "Aún no hay grabaciones",
  "library.emptyDesc": "Graba tu pantalla y aparecerá aquí para editar y exportar.",
  "library.title": "Tus grabaciones",
  "library.meta": "Exportaciones: {count} · {kind}",
  "library.unknownSize": "tamaño desconocido",
  "library.open": "Abrir",
  "library.delete": "Eliminar",

  "edit.back": "Biblioteca",
  "edit.previewPlaceholder":
    "La vista previa está disponible después de grabar en la aplicación de escritorio.",
  "edit.summary": "Recorte: {summary} · Salida {width}×{height} @ {fps}fps",
  "edit.trim": "Recorte",
  "edit.trimStart": "Inicio {time}",
  "edit.trimEnd": "Fin {time}",
  "edit.zoom": "Zoom automático",
  "edit.zoomFollow": "Seguir el cursor con zooms suaves",
  "edit.zoomIntensity": "Intensidad {percent}%",
  "edit.zoomHighlight": "Resaltar el puntero",
  "edit.zoomKeyframes": "{count} fotogramas clave de zoom",
  "edit.crop": "Recortar",
  "edit.cropField": "{field} {percent}%",
  "edit.framing": "Encuadre",
  "edit.padding": "Relleno {px}px",
  "edit.radius": "Radio de esquina {px}px",
  "edit.background": "Fondo",
  "edit.clipLength": "Duración del clip {time}",
  "edit.resetCrop": "Restablecer recorte",
  "edit.export": "Exportar",
  "edit.preset": "Formato",
  "edit.exportVideo": "Exportar vídeo",
  "edit.exportComplete": "Exportación completada",
  "edit.exportProgress": "Procesando {done} de {total}…",
  "edit.previousExports": "Exportaciones anteriores",
  "edit.copy": "Copiar",
  "edit.reveal": "Mostrar",
  "edit.noSelectionTitle": "Ninguna grabación seleccionada",
  "edit.noSelectionDesc": "Elige una grabación de la biblioteca para editar y exportar.",
  "edit.backToLibrary": "Volver a la biblioteca",

  "callouts.title": "Anotaciones",
  "callouts.add": "Añadir",
  "callouts.empty": "Sin anotaciones. Añade etiquetas o subtítulos con tiempo al vídeo.",
  "callouts.newText": "Nueva anotación",
  "callouts.placeholder": "Texto de la anotación",
  "callouts.at": "En {time}",
  "callouts.duration": "Duración {time}",
  "callouts.text": "Texto",
  "callouts.box": "Caja",
  "callouts.remove": "Eliminar",

  "rec.label": "GRAB",
  "rec.stop": "Detener",

  "error.captureUnsupported":
    "La captura de pantalla no está disponible aquí. Usa la aplicación de escritorio (pnpm first-run) para grabar.",
  "error.exportNeedsDesktop":
    "La exportación usa tu ffmpeg local a través de la aplicación de escritorio. Iníciala con pnpm first-run.",
  "error.micWarning": "Se solicitó el micrófono pero no se devolvió ninguna pista de audio.",
  "error.revealFailed": "No se pudo abrir un gestor de archivos: {message}",
  "error.copyFailed": "No se pudo copiar la ruta: {message}",
};

const DICTS: Record<Lang, Dict> = { en, "pt-BR": ptBR, es };

const STORAGE_KEY = "motion-studio:lang";

function isLang(value: string | null): value is Lang {
  return value === "en" || value === "pt-BR" || value === "es";
}

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // ignore unavailable storage
  }
  if (typeof navigator !== "undefined") {
    const nav = (navigator.language ?? "").toLowerCase();
    if (nav.startsWith("pt")) return "pt-BR";
    if (nav.startsWith("es")) return "es";
  }
  return "en";
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}

export interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore unavailable storage
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (key, vars) => interpolate(DICTS[lang][key] ?? DICTS.en[key] ?? key, vars),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}
