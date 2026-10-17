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
  "edit.previewFailed": "The preview could not play this recording ({reason}).",
  "edit.play": "Play",
  "edit.pause": "Pause",
  "edit.focusHint": "Click the frame to aim this zoom. It shows unzoomed while you aim.",
  "edit.focusDone": "Done",
  "edit.summary": "Trim: {summary} · Output {width}×{height} @ {fps}fps",
  "edit.trim": "Trim",
  "edit.trimStart": "Start {time}",
  "edit.trimEnd": "End {time}",
  "edit.zoom": "Zoom",
  "edit.zoomEnabled": "Enable smooth zoom",
  "edit.zoomIntensity": "Intensity {percent}%",
  "edit.zoomHighlight": "Highlight the pointer",
  "edit.zoomKeyframes": "{count} zoom keyframes",
  "edit.zoomMode": "Zoom source",
  "edit.zoomModeAuto": "Cursor",
  "edit.zoomModeManual": "Manual",
  "edit.zoomManualHint": "Play to the moment you want, add a zoom, then click the preview to aim it.",
  "edit.zoomAddStop": "Add zoom at {time}",
  "edit.zoomNoStops": "No zooms yet.",
  "edit.zoomStopLabel": "{time} · {scale}x",
  "edit.zoomStopScale": "Zoom {scale}x",
  "edit.zoomStopDuration": "Hold {time}",
  "edit.zoomRemoveStop": "Remove",
  "edit.zoomNoCursorTrack": "This recording has no cursor track, so cursor zoom has nothing to follow — either the desktop portal would not report the pointer, or the recording predates cursor tracking. Switch to Manual to place zooms yourself.",
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

  "drive.title": "Google Drive",
  "drive.notConfiguredTitle": "Google Drive is not configured",
  "drive.connected": "Connected",
  "drive.connectedAs": "Connected as {email}",
  "drive.disconnect": "Disconnect",
  "drive.connectDesc": "Connect an account to save exported videos to a “Motion Studio” folder in your Drive.",
  "drive.connect": "Connect Google Drive",
  "drive.connecting": "Waiting for browser sign-in…",
  "drive.save": "Save to Drive",
  "drive.saveTitle": "Upload this video to Google Drive",
  "drive.uploading": "Uploading {percent}%",
  "drive.open": "Open in Drive",
  "nav.drive": "Google Drive",
  "drive.notConfigured": "Optional. Set up Google Drive once to save exported videos to your Drive.",
  "drive.setupCta": "Set up Google Drive",
  "drive.setup.intro": "Save your exported videos straight to your Google Drive. It's optional and takes about 5 minutes to set up once: you create your own free Google OAuth client and paste it here.",
  "drive.setup.stateNotConfigured": "Not configured",
  "drive.setup.stateReady": "Credentials saved — not connected yet",
  "drive.setup.connectingHint": "Finish signing in to Google in the browser window that just opened, then come back here.",
  "drive.setup.clientTitle": "OAuth client",
  "drive.setup.fromApp": "Saved in this app.",
  "drive.setup.fromEnv": "Read from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env. Saving a client here overrides it.",
  "drive.setup.change": "Change credentials",
  "drive.setup.remove": "Remove credentials",
  "drive.setup.stepsTitle": "How to set it up",
  "drive.setup.openPage": "Open page",
  "drive.setup.clientId": "Client ID",
  "drive.setup.clientSecret": "Client secret",
  "drive.setup.show": "Show",
  "drive.setup.hide": "Hide",
  "drive.setup.save": "Save credentials",
  "drive.setup.saving": "Saving…",
  "drive.setup.invalidSecret": "The Client secret looks incomplete — copy the whole value (it usually starts with GOCSPX-).",
  "drive.setup.invalidId": "The Client ID should end with .apps.googleusercontent.com — copy it from the client you created in step 5.",
  "drive.setup.cancel": "Cancel",
  "drive.setup.noteUnverified": "When you connect, Google may warn that the app isn't verified. That's expected for your own personal client: click “Advanced” → “Go to … (unsafe)” → “Continue”.",
  "drive.setup.notePrivacy": "Motion Studio only asks for the drive.file permission: it can see nothing but the files it uploads, which go to a “Motion Studio” folder. Credentials and the sign-in token stay on this computer.",
  "drive.step1.title": "Create a Google Cloud project",
  "drive.step1.body": "Give it any name (e.g. “Motion Studio”) and click Create. Make sure it's selected at the top of the console.",
  "drive.step2.title": "Enable the Google Drive API",
  "drive.step2.body": "On the API page, click Enable.",
  "drive.step3.title": "Configure the consent screen",
  "drive.step3.body": "Click Get started, fill in the app name and your support email, choose Audience “External” and finish.",
  "drive.step4.title": "Add yourself as a test user",
  "drive.step4.body": "Under Audience → Test users, click Add users and enter the Google account you'll upload with.",
  "drive.step5.title": "Create the OAuth client",
  "drive.step5.body": "Click Create client, choose application type “Desktop app”, create it and copy the Client ID and Client secret.",
  "drive.step6.title": "Paste the credentials here",
  "drive.step6.body": "Then click Save and Connect Google Drive.",

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
  "edit.previewFailed": "A pré-visualização não conseguiu reproduzir esta gravação ({reason}).",
  "edit.play": "Reproduzir",
  "edit.pause": "Pausar",
  "edit.focusHint": "Clique no quadro para mirar este zoom. Enquanto você mira, o quadro aparece sem zoom.",
  "edit.focusDone": "Concluir",
  "edit.summary": "Corte: {summary} · Saída {width}×{height} @ {fps}fps",
  "edit.trim": "Corte",
  "edit.trimStart": "Início {time}",
  "edit.trimEnd": "Fim {time}",
  "edit.zoom": "Zoom",
  "edit.zoomEnabled": "Ativar zoom suave",
  "edit.zoomIntensity": "Intensidade {percent}%",
  "edit.zoomHighlight": "Destacar o ponteiro",
  "edit.zoomKeyframes": "{count} keyframes de zoom",
  "edit.zoomMode": "Origem do zoom",
  "edit.zoomModeAuto": "Cursor",
  "edit.zoomModeManual": "Manual",
  "edit.zoomManualHint": "Avance até o momento desejado, adicione um zoom e clique na prévia para mirar.",
  "edit.zoomAddStop": "Adicionar zoom em {time}",
  "edit.zoomNoStops": "Nenhum zoom ainda.",
  "edit.zoomStopLabel": "{time} · {scale}x",
  "edit.zoomStopScale": "Zoom {scale}x",
  "edit.zoomStopDuration": "Permanência {time}",
  "edit.zoomRemoveStop": "Remover",
  "edit.zoomNoCursorTrack": "Esta gravação não tem rastro do cursor, então o zoom por cursor não tem o que seguir — ou o portal do sistema não informou a posição do cursor, ou a gravação é anterior ao rastreamento. Troque para Manual e marque os zooms você mesmo.",
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

  "drive.title": "Google Drive",
  "drive.notConfiguredTitle": "O Google Drive não está configurado",
  "drive.connected": "Conectado",
  "drive.connectedAs": "Conectado como {email}",
  "drive.disconnect": "Desconectar",
  "drive.connectDesc": "Conecte uma conta para salvar os vídeos exportados numa pasta “Motion Studio” no seu Drive.",
  "drive.connect": "Conectar Google Drive",
  "drive.connecting": "Aguardando login no navegador…",
  "drive.save": "Salvar no Drive",
  "drive.saveTitle": "Enviar este vídeo para o Google Drive",
  "drive.uploading": "Enviando {percent}%",
  "drive.open": "Abrir no Drive",
  "nav.drive": "Google Drive",
  "drive.notConfigured": "Opcional. Configure o Google Drive uma vez para salvar os vídeos exportados no seu Drive.",
  "drive.setupCta": "Configurar Google Drive",
  "drive.setup.intro": "Salve seus vídeos exportados direto no seu Google Drive. É opcional e leva uns 5 minutos para configurar uma única vez: você cria um cliente OAuth gratuito no Google e cola aqui.",
  "drive.setup.stateNotConfigured": "Não configurado",
  "drive.setup.stateReady": "Credenciais salvas — ainda não conectado",
  "drive.setup.connectingHint": "Conclua o login do Google na janela do navegador que acabou de abrir e depois volte aqui.",
  "drive.setup.clientTitle": "Cliente OAuth",
  "drive.setup.fromApp": "Salvo neste app.",
  "drive.setup.fromEnv": "Lido de GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no .env. Salvar um cliente aqui tem prioridade.",
  "drive.setup.change": "Alterar credenciais",
  "drive.setup.remove": "Remover credenciais",
  "drive.setup.stepsTitle": "Como configurar",
  "drive.setup.openPage": "Abrir página",
  "drive.setup.clientId": "ID do cliente (Client ID)",
  "drive.setup.clientSecret": "Chave secreta do cliente (Client secret)",
  "drive.setup.show": "Mostrar",
  "drive.setup.hide": "Ocultar",
  "drive.setup.save": "Salvar credenciais",
  "drive.setup.saving": "Salvando…",
  "drive.setup.invalidSecret": "A chave secreta parece incompleta — copie o valor inteiro (normalmente começa com GOCSPX-).",
  "drive.setup.invalidId": "O ID do cliente deve terminar com .apps.googleusercontent.com — copie do cliente criado no passo 5.",
  "drive.setup.cancel": "Cancelar",
  "drive.setup.noteUnverified": "Ao conectar, o Google pode avisar que o app não foi verificado. Isso é esperado para um cliente pessoal seu: clique em “Avançado” → “Acessar … (não seguro)” → “Continuar”.",
  "drive.setup.notePrivacy": "O Motion Studio só pede a permissão drive.file: ele enxerga apenas os arquivos que ele mesmo envia, que vão para a pasta “Motion Studio”. As credenciais e o token de login ficam neste computador.",
  "drive.step1.title": "Crie um projeto no Google Cloud",
  "drive.step1.body": "Dê qualquer nome (ex.: “Motion Studio”) e clique em Criar. Confira se ele ficou selecionado no topo do console.",
  "drive.step2.title": "Ative a Google Drive API",
  "drive.step2.body": "Na página da API, clique em Ativar.",
  "drive.step3.title": "Configure a tela de consentimento",
  "drive.step3.body": "Clique em Vamos começar, preencha o nome do app e seu email de suporte, escolha o público “Externo” e conclua.",
  "drive.step4.title": "Adicione você como usuário de teste",
  "drive.step4.body": "Em Público-alvo → Usuários de teste, clique em Adicionar usuários e informe a conta Google que vai usar para enviar.",
  "drive.step5.title": "Crie o cliente OAuth",
  "drive.step5.body": "Clique em Criar cliente, escolha o tipo de aplicativo “App para computador”, crie e copie o ID do cliente e a chave secreta.",
  "drive.step6.title": "Cole as credenciais aqui",
  "drive.step6.body": "Depois clique em Salvar e em Conectar Google Drive.",

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
  "edit.previewFailed": "La vista previa no pudo reproducir esta grabación ({reason}).",
  "edit.play": "Reproducir",
  "edit.pause": "Pausar",
  "edit.focusHint": "Haz clic en el cuadro para apuntar este zoom. Mientras apuntas, se muestra sin zoom.",
  "edit.focusDone": "Listo",
  "edit.summary": "Recorte: {summary} · Salida {width}×{height} @ {fps}fps",
  "edit.trim": "Recorte",
  "edit.trimStart": "Inicio {time}",
  "edit.trimEnd": "Fin {time}",
  "edit.zoom": "Zoom",
  "edit.zoomEnabled": "Activar zoom suave",
  "edit.zoomIntensity": "Intensidad {percent}%",
  "edit.zoomHighlight": "Resaltar el puntero",
  "edit.zoomKeyframes": "{count} fotogramas clave de zoom",
  "edit.zoomMode": "Origen del zoom",
  "edit.zoomModeAuto": "Cursor",
  "edit.zoomModeManual": "Manual",
  "edit.zoomManualHint": "Avanza hasta el momento que quieras, añade un zoom y haz clic en la vista previa para apuntarlo.",
  "edit.zoomAddStop": "Añadir zoom en {time}",
  "edit.zoomNoStops": "Todavía no hay zooms.",
  "edit.zoomStopLabel": "{time} · {scale}x",
  "edit.zoomStopScale": "Zoom {scale}x",
  "edit.zoomStopDuration": "Permanencia {time}",
  "edit.zoomRemoveStop": "Quitar",
  "edit.zoomNoCursorTrack": "Esta grabación no tiene rastro del cursor, así que el zoom por cursor no tiene qué seguir — o el portal del sistema no informó la posición del cursor, o la grabación es anterior al seguimiento. Cambia a Manual para colocar los zooms tú mismo.",
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

  "drive.title": "Google Drive",
  "drive.notConfiguredTitle": "Google Drive no está configurado",
  "drive.connected": "Conectado",
  "drive.connectedAs": "Conectado como {email}",
  "drive.disconnect": "Desconectar",
  "drive.connectDesc": "Conecta una cuenta para guardar los vídeos exportados en una carpeta “Motion Studio” de tu Drive.",
  "drive.connect": "Conectar Google Drive",
  "drive.connecting": "Esperando el inicio de sesión en el navegador…",
  "drive.save": "Guardar en Drive",
  "drive.saveTitle": "Subir este vídeo a Google Drive",
  "drive.uploading": "Subiendo {percent}%",
  "drive.open": "Abrir en Drive",
  "nav.drive": "Google Drive",
  "drive.notConfigured": "Opcional. Configura Google Drive una vez para guardar los vídeos exportados en tu Drive.",
  "drive.setupCta": "Configurar Google Drive",
  "drive.setup.intro": "Guarda tus vídeos exportados directamente en tu Google Drive. Es opcional y lleva unos 5 minutos configurarlo una sola vez: creas un cliente OAuth gratuito en Google y lo pegas aquí.",
  "drive.setup.stateNotConfigured": "No configurado",
  "drive.setup.stateReady": "Credenciales guardadas — aún sin conectar",
  "drive.setup.connectingHint": "Termina de iniciar sesión en Google en la ventana del navegador que se acaba de abrir y vuelve aquí.",
  "drive.setup.clientTitle": "Cliente OAuth",
  "drive.setup.fromApp": "Guardado en esta app.",
  "drive.setup.fromEnv": "Leído de GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env. Guardar un cliente aquí tiene prioridad.",
  "drive.setup.change": "Cambiar credenciales",
  "drive.setup.remove": "Eliminar credenciales",
  "drive.setup.stepsTitle": "Cómo configurarlo",
  "drive.setup.openPage": "Abrir página",
  "drive.setup.clientId": "ID de cliente (Client ID)",
  "drive.setup.clientSecret": "Secreto del cliente (Client secret)",
  "drive.setup.show": "Mostrar",
  "drive.setup.hide": "Ocultar",
  "drive.setup.save": "Guardar credenciales",
  "drive.setup.saving": "Guardando…",
  "drive.setup.invalidSecret": "El secreto parece incompleto — copia el valor completo (normalmente empieza por GOCSPX-).",
  "drive.setup.invalidId": "El ID de cliente debe terminar en .apps.googleusercontent.com — cópialo del cliente creado en el paso 5.",
  "drive.setup.cancel": "Cancelar",
  "drive.setup.noteUnverified": "Al conectar, Google puede avisar que la app no está verificada. Es normal para tu propio cliente personal: haz clic en “Configuración avanzada” → “Ir a … (no seguro)” → “Continuar”.",
  "drive.setup.notePrivacy": "Motion Studio solo pide el permiso drive.file: solo ve los archivos que sube, que van a una carpeta “Motion Studio”. Las credenciales y el token de inicio de sesión se quedan en este equipo.",
  "drive.step1.title": "Crea un proyecto en Google Cloud",
  "drive.step1.body": "Ponle cualquier nombre (p. ej. “Motion Studio”) y haz clic en Crear. Comprueba que esté seleccionado arriba en la consola.",
  "drive.step2.title": "Activa la Google Drive API",
  "drive.step2.body": "En la página de la API, haz clic en Habilitar.",
  "drive.step3.title": "Configura la pantalla de consentimiento",
  "drive.step3.body": "Haz clic en Comenzar, completa el nombre de la app y tu correo de soporte, elige el público “Externo” y termina.",
  "drive.step4.title": "Añádete como usuario de prueba",
  "drive.step4.body": "En Público → Usuarios de prueba, haz clic en Agregar usuarios e indica la cuenta de Google con la que vas a subir.",
  "drive.step5.title": "Crea el cliente OAuth",
  "drive.step5.body": "Haz clic en Crear cliente, elige el tipo de aplicación “App de escritorio”, créalo y copia el ID de cliente y el secreto.",
  "drive.step6.title": "Pega las credenciales aquí",
  "drive.step6.body": "Después haz clic en Guardar y en Conectar Google Drive.",

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
