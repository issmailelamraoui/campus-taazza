import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  AtSign,
  BookOpen,
  Bookmark,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Flag,
  FileText,
  FolderOpen,
  Hash,
  Heart,
  Link as LinkIcon,
  LockKeyhole,
  LoaderCircle,
  Megaphone,
  MessageCircle,
  Pin,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { useApp } from "../context";
import { COMMUNITY_YEAR_CHANNELS, normalizeCommunityChannel, canonicalCommunityMessageId } from "../lib/community";
import { SUPPORTED_FILE_ACCEPT, isSupportedFile, fileKey, filesFromDrop, createSessionAttachment, getSessionFile, releaseSessionAttachment } from "../lib/files";
import { partLabel } from "../lib/resources";
import { normalizeSearch } from "../utils";
import { copyText } from "../lib/clipboard";
import UploadModal from "../components/UploadModal";
import { Select } from "../components/Select";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
} from "../components/ui";
import "./community.css";

const CHANNELS = [
  {
    id: "general",
    fr: "Chat général",
    en: "General chat",
    ar: "الدردشة العامة",
    description: [
      "Le lieu pour échanger avec tous les étudiants de votre faculté, toutes filières confondues.",
      "A place to talk with everyone in your faculty, across all programs.",
      "مكان للتواصل مع جميع طلبة كليتكم من مختلف المسالك.",
    ],
  },
  {
    id: "important",
    fr: "Discussions importantes",
    en: "Important discussions",
    ar: "مناقشات مهمة",
    description: [
      "Les informations utiles et les échanges à retrouver facilement.",
      "Useful information and conversations to keep close.",
      "المعلومات المفيدة والمناقشات التي تستحق المتابعة.",
    ],
  },
];
const normalizedChannel = normalizeCommunityChannel;
const accountName = value => String(value || '').trim().toLowerCase();
const createMessageId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const messagePreview = (message) => message?.content || message?.attachments?.map(file => file.name || file.title).join(", ") || message?.attachment?.title || "";
const dayKey = (value) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(
    new Date(value),
  );
const motion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

function MessageContent({ children, query = "" }) {
  const text = String(children || "");
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = escaped ? text.split(new RegExp(`(${escaped})`, "gi")) : [text];
  return (
    <p className="community-message-content" dir="auto">
      {parts.map((part, index) =>
        escaped && part.toLowerCase() === query.trim().toLowerCase() ? (
          <mark key={index}>{part}</mark>
        ) : (
          <React.Fragment key={index}>
            {part.split(/(@[\w.-]+)/g).map((piece, i) =>
              piece.startsWith("@") ? (
                <span className="community-mention" key={i}>
                  {piece}
                </span>
              ) : (
                piece
              ),
            )}
          </React.Fragment>
        ),
      )}
    </p>
  );
}

function AttachmentClassification({ attachment }) {
  const { t, language } = useApp();
  if (!attachment.module) return null;
  return <span className="community-file-classification">
    <span className="community-file-module"><bdi>{attachment.module}</bdi><span>S{attachment.semester}</span></span>
    <span className="community-file-labels"><span className={`community-file-category community-file-category-${attachment.category}`}>{t(attachment.category)}</span><span>{partLabel(attachment.part, language)}</span></span>
    {attachment.filiereName && <small className="community-file-program" dir="auto">{attachment.filiereName}</small>}
    {attachment.author && <small className="community-file-author" dir="auto">{attachment.author}</small>}
  </span>;
}

function MessageActions({ label, actions, quickActions, children, ...articleProps }) {
  const available = actions.length > 0;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const articleRef = useRef(null);
  const menuRef = useRef(null);
  const gesture = useRef({ timer: null, point: null, pointerId: null, suppressClick: false });
  const keyboardOrigin = useRef(false);
  const anchor = useRef(null);
  const id = React.useId();
  const cancelHold = () => {
    clearTimeout(gesture.current.timer);
    gesture.current.timer = null;
  };
  const close = (restore = false) => {
    cancelHold();
    setOpen(false);
    if (restore && keyboardOrigin.current) articleRef.current?.focus({ preventScroll: true });
  };
  const show = (point, fromKeyboard = false) => {
    if (!available) return;
    cancelHold();
    anchor.current = point;
    keyboardOrigin.current = fromKeyboard;
    setOpen(true);
  };
  const endPointer = (event) => {
    if (event.pointerId !== gesture.current.pointerId) return;
    cancelHold();
    gesture.current.pointerId = null;
    // Keep suppressClick until a new press: the release can generate a click
    // on the menu portal, even though it began on the message beneath it.
  };
  useEffect(() => () => cancelHold(), []);
  useLayoutEffect(() => {
    if (!open) return;
    const bubble = articleRef.current.querySelector('.community-message-bubble').getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const rightEdge = leftEdge + (viewport?.width || window.innerWidth);
    const bottomBar = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
    const bottomEdge = Math.min(topEdge + (viewport?.height || window.innerHeight), bottomBar?.height ? bottomBar.top : window.innerHeight);
    const point = anchor.current || { x: bubble.left, y: bubble.bottom };
    const left = document.documentElement.dir === "rtl" ? point.x - menu.width : point.x;
    const availableHeight = Math.max(120, bottomEdge - topEdge - 16);
    const height = Math.min(menu.height, availableHeight);
    const top = point.y + height + 12 < bottomEdge ? point.y + 10 : point.y - height - 10;
    setPosition({
      left: Math.max(leftEdge + 8, Math.min(left, rightEdge - menu.width - 8)),
      top: Math.max(topEdge + 8, Math.min(top, bottomEdge - height - 8)),
      maxHeight: availableHeight,
    });
    if (keyboardOrigin.current) {
      menuRef.current
        .querySelector('[role^="menuitem"]:not(:disabled)')
        ?.focus({ preventScroll: true });
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target)) close();
    };
    const focusOutside = (event) => {
      if (!articleRef.current?.contains(event.target)) outside(event);
    };
    const dismiss = () => close();
    const scrollOutside = (event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("pointerup", endPointer, true);
    document.addEventListener("pointercancel", endPointer, true);
    document.addEventListener("focusin", focusOutside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scrollOutside, true);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("pointerup", endPointer, true);
      document.removeEventListener("pointercancel", endPointer, true);
      document.removeEventListener("focusin", focusOutside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scrollOutside, true);
      window.visualViewport?.removeEventListener("resize", dismiss);
    };
  }, [open]);
  function keyboard(event) {
    // Keyboard activation is a deliberate new interaction, just like a fresh
    // touch. Opening the menu must not disable its keyboard controls.
    if (["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab", "Enter", " "].includes(event.key)) {
      gesture.current.suppressClick = false;
      keyboardOrigin.current = true;
    }
    const items = [
      ...menuRef.current.querySelectorAll('[role^="menuitem"]:not(:disabled)'),
    ];
    const index = items.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(true);
  }
  return (
    <article
        {...articleProps}
        ref={articleRef}
        className={`${articleProps.className} ${open ? "has-open-menu" : ""}`}
        tabIndex={available ? 0 : undefined}
        aria-label={label}
        aria-haspopup={available ? "menu" : undefined}
        aria-expanded={available ? open : undefined}
        aria-controls={open ? id : undefined}
        aria-describedby={available ? "community-message-actions-hint" : undefined}
        aria-keyshortcuts={available ? "Shift+F10" : undefined}
        onPointerDownCapture={(event) => {
          if (!available || !event.isPrimary || event.button !== 0) return;
          if (menuRef.current?.contains(event.target)) {
            // Moving or releasing the opening finger emits no new pointerdown.
            // A primary press here is a separate, intentional menu interaction.
            gesture.current.suppressClick = false;
            gesture.current.pointerId = null;
            return;
          }
          if (!articleRef.current.contains(event.target)) return;
          cancelHold();
          gesture.current.suppressClick = false;
          gesture.current.pointerId = event.pointerId;
          gesture.current.point = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
          gesture.current.timer = setTimeout(() => {
            gesture.current.suppressClick = true;
            show(gesture.current.point);
          }, 500);
        }}
        onPointerMove={(event) => {
          const point = gesture.current.point;
          if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) cancelHold();
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={cancelHold}
        onClickCapture={(event) => {
          if (gesture.current.suppressClick) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onContextMenu={(event) => {
          if (!articleRef.current.contains(event.target)) return;
          event.preventDefault();
          if ((gesture.current.pointerId !== null && gesture.current.point?.pointerType === 'touch') ||
              event.nativeEvent.pointerType === 'touch' || event.nativeEvent.sourceCapabilities?.firesTouchEvents) {
            gesture.current.suppressClick = true;
          }
          show({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (!articleRef.current.contains(event.target)) return;
          if (gesture.current.pointerId === null && ['Enter', ' '].includes(event.key)) {
            gesture.current.suppressClick = false;
          }
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu' ||
              (event.target === event.currentTarget && ['Enter', ' '].includes(event.key))) {
            event.preventDefault();
            gesture.current.suppressClick = false;
            show(null, true);
          }
        }}
      >
      {children}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="menu"
            aria-label={label}
            className="community-message-menu"
            style={position}
            onKeyDown={keyboard}
          >
            <div className="community-menu-reactions">
              {quickActions.filter(action => action.key !== 'reply').map(({ key, label: actionLabel, icon: Icon, run, active }) => (
                <button key={key} type="button" role="menuitemcheckbox" aria-checked={active} className={active ? 'is-active' : undefined}
                  onClick={() => { close(true); run(); }}>
                  <Icon size={17} fill={active && key === 'heart' ? 'currentColor' : 'none'} /><span>{actionLabel}</span>
                </button>
              ))}
            </div>
            {actions.map(
              ({ key, label: actionLabel, icon: Icon, run, disabled, danger }) => (
                <button
                  key={key}
                  role="menuitem"
                  type="button"
                  disabled={disabled}
                  className={danger ? "is-danger" : undefined}
                  onClick={() => {
                    close(true);
                    run();
                  }}
                >
                  <Icon size={16} />
                  <span>{actionLabel}</span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </article>
  );
}

function AttachmentPicker({ fileInputRef, folderInputRef, tr, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const id = React.useId();
  const label = tr('Joindre un document', 'Attach a document', 'إرفاق مستند');
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8)), top: Math.max(8, trigger.top - menu.height - 8) });
    menuRef.current.querySelector('button')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open]);
  return <>
    <button ref={triggerRef} type="button" disabled={disabled} className="community-composer-attach" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Plus size={20} /></button>
    {open && createPortal(<div ref={menuRef} id={id} role="menu" aria-label={label} className="community-message-menu community-attachment-menu" style={position}
      onKeyDown={event => {
        const buttons = [...menuRef.current.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }
        else if (event.key === 'Tab') setOpen(false);
      }}>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); fileInputRef.current?.click(); }}><FileText size={18} /><span>{tr('Fichiers', 'Files', 'ملفات')}<small>{tr('Un ou plusieurs documents', 'One or more documents', 'ملف واحد أو عدة ملفات')}</small></span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); folderInputRef.current?.click(); }}><FolderOpen size={18} /><span>{tr('Dossier', 'Folder', 'مجلد')}<small>{tr('Avec ses sous-dossiers', 'Including nested folders', 'مع المجلدات الفرعية')}</small></span></button>
    </div>, document.body)}
  </>;
}

function ChannelNavigation({
  channel,
  changeChannel,
  faculty,
  filiere,
  messages,
  tr,
}) {
  const previews = useMemo(() => {
    const map = {};
    [...messages]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .forEach((message) => {
        map[normalizedChannel(message.channel)] = message;
      });
    return map;
  }, [messages]);
  return (
    <aside
      className="community-channel-panel"
      aria-label={tr(
        "Canaux de discussion",
        "Discussion channels",
        "قنوات المناقشة",
      )}
    >
      <div className="community-context">
        <div className="community-context-top">
          <h1>{tr("Communauté", "Community", "المجتمع")}</h1>
          <span>
            <LockKeyhole size={12} />
            {faculty?.code}
          </span>
        </div>
        <h2 dir="auto">{filiere?.name}</h2>
        <p dir="auto">{faculty?.name}</p>
      </div>
      <div className="community-channel-scroll">
        <h3 className="community-channel-section-label">
          {tr("CANAUX DE DISCUSSION", "DISCUSSION CHANNELS", "قنوات المناقشة")}
        </h3>
        <nav className="community-channel-list">
          {CHANNELS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-label={tr(item.fr, item.en, item.ar)}
              className={`community-channel-button ${channel === item.id ? "active" : ""}`}
              aria-current={channel === item.id ? "page" : undefined}
              onClick={() => changeChannel(item.id)}
            >
              <Hash size={17} />
              <span className="community-channel-copy">
                <strong>{tr(item.fr, item.en, item.ar)}</strong>
                <span dir="auto">
                  {messagePreview(previews[item.id]) ||
                    tr(
                      "Commencez la discussion",
                      "Start the conversation",
                      "ابدأ المناقشة",
                    )}
                </span>
              </span>
              {channel === item.id && <span className="community-active-dot" />}
            </button>
          ))}
        </nav>
        <h3 className="community-channel-section-label community-program-label">
          {tr("Chat de filière", "Program chat", "دردشة المسلك")}
        </h3>
        <nav className="community-channel-list community-program-channels">
          {COMMUNITY_YEAR_CHANNELS.map(item => (
            <button
              type="button"
              key={item.id}
              className={`community-channel-button ${channel === item.id ? "active" : ""}`}
              aria-label={item.label}
              aria-current={channel === item.id ? "page" : undefined}
              onClick={() => changeChannel(item.id)}
            >
              <Hash size={17} />
              <span className="community-channel-copy">
                <strong>{item.label}</strong>
                <span dir="auto">{messagePreview(previews[item.id]) || tr("Une conversation pour toute l’année", "One conversation for the whole academic year", "محادثة واحدة للسنة الدراسية كاملة")}</span>
              </span>
              {channel === item.id && <span className="community-active-dot" />}
            </button>
          ))}
        </nav>
        <p className="community-channel-note">
          {tr(
            "Les trois années de votre filière vous sont ouvertes.",
            "All three academic years in your program are open to you.",
            "السنوات الثلاث لمسلككم متاحة لكم.",
          )}
        </p>
      </div>
      <div className="community-channel-footer">
        <span />
        {tr(
          "Espace étudiant",
          "Student space",
          "فضاء الطلبة",
        )}
      </div>
    </aside>
  );
}

export default function CommunityPage() {
  const {
    tr,
    language,
    user,
    selection,
    faculty,
    filiere,
    messages,
    channels = [],
    allMessages,
    sendMessage: publishMessage,
    retryMessage,
    discardMessage,
    deleteMessage: removeMessage,
    toggleMessageReaction,
    toggleMessagePin,
    reportMessage,
    promoteMessage: publishAnnouncement,
    announcements,
    notify,
    saveItem,
    isSaved,
    resources,
    openDocument,
    t,
  } = useApp();
  const [params, setParams] = useSearchParams();
  const requestedChannel = normalizedChannel(
    params.get("channel") || "general",
  );
  const requestedMessage = canonicalCommunityMessageId(params.get("message"), allMessages);
  const channel = requestedChannel || "general";
  const [mobileConversation, setMobileConversation] = useState(
    params.has("channel") || params.has("message"),
  );
  const [drafts, setDrafts] = useState({});
  const draft = drafts[channel] || "";
  const setDraft = (value) =>
    setDrafts((previous) => ({
      ...previous,
      [channel]:
        typeof value === "function" ? value(previous[channel] || "") : value,
    }));
  const [replyTo, setReplyTo] = useState(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState({});
  const attachmentDraftsRef = useRef(attachmentDrafts);
  attachmentDraftsRef.current = attachmentDrafts;
  const attachments = attachmentDrafts[channel] || [];
  const [devicePreview, setDevicePreview] = useState(null);
  const [attachmentClassification, setAttachmentClassification] = useState(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [sending, setSending] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [showPins, setShowPins] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const highlightTimer = useRef(null);
  const jumpFrame = useRef(null);
  const lastRequestedMessage = useRef(null);
  const [showLatest, setShowLatest] = useState(false);
  const [report, setReport] = useState(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [promotion, setPromotion] = useState(null);
  const [promotionTitle, setPromotionTitle] = useState("");
  const composerRef = useRef(null);
  const historyRef = useRef(null);
  const searchRef = useRef(null);
  const searchTriggerRef = useRef(null);
  const mobileBackRef = useRef(null);
  const autoFollow = useRef(true);
  const academicScope = `${user.id}:${selection?.facultyId || ""}:${selection?.filiereId || ""}`;
  const previousScope = useRef(academicScope);
  const currentScope = useRef(academicScope);
  currentScope.current = academicScope;
  useEffect(() => {
    if (previousScope.current === academicScope) return;
    previousScope.current = academicScope;
    for (const attachment of Object.values(attachmentDraftsRef.current).flat()) releaseSessionAttachment(attachment.id);
    setDrafts({});
    setAttachmentDrafts({});
    setReplyTo(null);
    setAttachmentClassification(null);
    setDevicePreview(null);
    setAttachmentError("");
    setSending(false);
    setReport(null);
    setPromotion(null);
    setHighlight(null);
  }, [academicScope]);
  useEffect(() => () => {
    clearTimeout(highlightTimer.current);
    cancelAnimationFrame(jumpFrame.current);
  }, [academicScope, channel]);
  const locale =
    language === "ar" ? "ar-MA" : language === "en" ? "en-GB" : "fr-FR";
  const isAdmin = ["global_admin", "faculty_admin", "moderator"].includes(user?.role);
  const channelInfo = CHANNELS.find((item) => item.id === channel);
  const yearInfo = COMMUNITY_YEAR_CHANNELS.find(item => item.id === channel);
  const channelLabel = channelInfo
    ? tr(channelInfo.fr, channelInfo.en, channelInfo.ar)
    : yearInfo.label;
  const configuredChannel = channels.find(item => item.id === (yearInfo ? "filiere" : channel));
  const blocked = Boolean(user.chatBlocked || user.chat_blocked);
  const missingProgram = Boolean(yearInfo && !selection?.filiereId);
  const readOnly = Boolean(!isAdmin && configuredChannel?.read_only);
  const composerDisabled = sending || blocked || missingProgram || readOnly;
  const unavailableReason = blocked
    ? tr("Votre accès aux discussions a été suspendu par l’administration.", "Your chat access has been suspended by administration.", "علّقت الإدارة وصولك إلى المناقشات.")
    : missingProgram
      ? tr("Choisissez une filière dans votre compte pour accéder à ce chat.", "Choose a program in your account to access this chat.", "اختر مسلكاً في حسابك للوصول إلى هذه الدردشة.")
      : readOnly
        ? tr("Cette discussion est en lecture seule. L’administration peut y publier.", "This conversation is read only. Administration can publish here.", "هذه المناقشة للقراءة فقط. يمكن للإدارة النشر فيها.")
        : "";
  const channelDescription = configuredChannel?.description || (channelInfo
    ? tr(...channelInfo.description)
    : tr(
        `${filiere?.name || tr("Votre filière", "Your program", "مسلكك")} · Une conversation pour toute l’année ${yearInfo.label}, accessible à tous les semestres.`,
        `${filiere?.name || tr("Votre filière", "Your program", "مسلكك")} · One conversation for ${yearInfo.label}, open to students in every semester.`,
        `${filiere?.name || tr("Votre filière", "Your program", "مسلكك")} · محادثة واحدة للسنة ${yearInfo.label} متاحة لطلبة جميع الفصول.`,
      ));
  const channelSummary = channel === 'general'
    ? tr(`Toute la faculté · ${faculty?.code || ''}`, `All faculty students · ${faculty?.code || ''}`, `جميع طلبة الكلية · ${faculty?.code || ''}`)
    : channel === 'important'
      ? tr('Les échanges à retenir', 'Conversations to keep', 'مناقشات تستحق المتابعة')
      : filiere?.name;
  const currentMessages = useMemo(
    () =>
      messages
        .filter((item) => normalizedChannel(item.channel) === channel)
        .sort((a, b) => new Date(a.date) - new Date(b.date)),
    [messages, channel],
  );
  const pins = currentMessages.filter((item) => item.pinned);
  const needle = normalizeSearch(query.trim());
  const visibleMessages = useMemo(
    () =>
      needle
        ? currentMessages.filter((message) =>
            normalizeSearch(
              `${message.content} ${message.author} ${message.username || ""} ${messagePreview(message)} ${message.attachments?.map(file => `${file.name || ""} ${file.title || ""} ${file.path || ""} ${file.module || ""} ${file.filiereName || ""} ${file.author || ""} ${file.category ? t(file.category) : ""} ${file.part ? partLabel(file.part, language) : ""} ${file.semester ? `S${file.semester}` : ""}`).join(" ") || ""} ${message.attachment?.title || ""} ${message.attachment?.module || ""}`,
            ).includes(needle),
          )
        : currentMessages,
    [currentMessages, needle, language, t],
  );

  function scrollLatest(behavior = "auto") {
    const history = historyRef.current;
    if (history) history.scrollTo({ top: history.scrollHeight, behavior });
    autoFollow.current = true;
    setShowLatest(false);
  }
  function scrollMessage(id, focus = false) {
    const history = historyRef.current;
    const node = document.getElementById(id);
    if (!history || !node || !history.contains(node)) return;
    history.scrollTo({
      top:
        node.getBoundingClientRect().top -
        history.getBoundingClientRect().top +
        history.scrollTop -
        30,
      behavior: motion(),
    });
    clearTimeout(highlightTimer.current);
    setHighlight(id);
    highlightTimer.current = setTimeout(() => {
      setHighlight(null);
      highlightTimer.current = null;
    }, 1600);
    if (focus) node.focus({ preventScroll: true });
  }
  function jumpToMessage(id) {
    setShowPins(false);
    setShowSearch(false);
    setQuery("");
    setMobileConversation(true);
    setParams({ channel, message: id });
    const focus = document.documentElement.dataset.inputModality === 'keyboard';
    cancelAnimationFrame(jumpFrame.current);
    jumpFrame.current = requestAnimationFrame(() => scrollMessage(id, focus));
  }

  useEffect(() => {
    const value = params.get("channel");
    if (value && value !== channel) {
      const next = new URLSearchParams(params);
      next.set("channel", channel);
      setParams(next, { replace: true });
    }
  }, [params, channel, setParams]);
  useEffect(() => {
    setReplyTo(null);
    setShowSearch(false);
    setQuery("");
    setShowPins(false);
    setDevicePreview(null);
    setAttachmentError("");
    setHighlight(null);
    autoFollow.current = true;
  }, [channel]);
  useEffect(() => {
    if (!requestedMessage) {
      lastRequestedMessage.current = null;
      return;
    }
    if (!currentMessages.some((item) => item.id === requestedMessage)) return;
    const key = `${academicScope}:${channel}:${requestedMessage}`;
    if (lastRequestedMessage.current === key) return;
    setShowSearch(false);
    setQuery("");
    setMobileConversation(true);
    const focus = document.documentElement.dataset.inputModality === 'keyboard';
    const frame = requestAnimationFrame(() => {
      lastRequestedMessage.current = key;
      scrollMessage(requestedMessage, focus);
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedMessage, channel, currentMessages.length, academicScope]);
  useLayoutEffect(() => {
    if (needle) {
      if (historyRef.current) historyRef.current.scrollTop = 0;
      return;
    }
    if (
      requestedMessage &&
      currentMessages.some((item) => item.id === requestedMessage)
    )
      return;
    if (autoFollow.current) scrollLatest();
  }, [channel, currentMessages.length, needle, mobileConversation]);
  useEffect(() => {
    if (showSearch) searchRef.current?.focus();
  }, [showSearch]);
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (input) {
      input.style.height = "38px";
      input.style.height = `${Math.min(96, Math.max(38, input.scrollHeight))}px`;
    }
  }, [draft, mobileConversation]);

  function changeChannel(id) {
    setMobileConversation(true);
    if (id !== channel || requestedMessage) setParams({ channel: id });
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches)
        mobileBackRef.current?.focus({ preventScroll: true });
    });
  }
  function backToChannels() {
    setMobileConversation(false);
    requestAnimationFrame(() =>
      document
        .querySelector('.community-channel-button[aria-current="page"]')
        ?.focus({ preventScroll: true }),
    );
  }
  function addDeviceFiles(entries) {
    if (composerDisabled) return;
    const existingKeys = new Set(attachments.map(attachment => {
      const session = getSessionFile(attachment.id);
      return session && fileKey(session.file, attachment.path);
    }));
    const selected = [];
    let unsupported = 0;
    for (const { file, path } of entries) {
      if (!isSupportedFile(file)) { unsupported += 1; continue; }
      const key = fileKey(file, path);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      selected.push({ file, path });
    }
    if (selected.length) setAttachmentClassification({ channel, entries: selected, existingAttachments: attachments });
    setAttachmentError(unsupported ? tr(
      `${unsupported} fichier(s) ignoré(s) : format non pris en charge.`,
      `${unsupported} file(s) skipped: unsupported format.`,
      `تم تجاهل ${unsupported} ملف لعدم دعم تنسيقه.`,
    ) : entries.length && !selected.length ? tr(
      "Ces fichiers sont déjà sélectionnés.", "These files are already selected.", "هذه الملفات محددة بالفعل.",
    ) : "");
  }
  function selectDeviceFiles(event) {
    addDeviceFiles(Array.from(event.target.files || []).map(file => ({
      file, path: file.webkitRelativePath || file.name,
    })));
    event.target.value = "";
  }
  function confirmDeviceFiles(classified) {
    const targetChannel = attachmentClassification.channel;
    const selected = classified.map(({ file, path, meta }) => ({
      ...createSessionAttachment(file, path), ...meta, originalName: file.name,
    }));
    setAttachmentDrafts(previous => ({
      ...previous, [targetChannel]: [...(previous[targetChannel] || []), ...selected],
    }));
    setAttachmentError("");
  }
  async function dropDeviceFiles(event) {
    event.preventDefault();
    try { addDeviceFiles(await filesFromDrop(event.dataTransfer)); }
    catch { setAttachmentError(tr("Ce dossier n’a pas pu être lu. Essayez le sélecteur de fichiers.", "This folder could not be read. Try the file picker.", "تعذرت قراءة هذا المجلد. جرّب اختيار الملفات.")); }
  }
  function removeDeviceAttachment(id) {
    setAttachmentDrafts(previous => ({
      ...previous, [channel]: (previous[channel] || []).filter(file => file.id !== id),
    }));
    releaseSessionAttachment(id);
  }
  async function openDeviceAttachment(attachment) {
    const session = getSessionFile(attachment.id);
    const url = session?.url || attachment.url;
    if (!url) {
      notify(tr("Ce fichier n’est plus disponible.", "This file is no longer available.", "لم يعد هذا الملف متاحاً."));
      return;
    }
    try {
      let text = null;
      if (attachment.fileType === "TXT") {
        if (session) text = await session.file.text();
        else {
          const response = await fetch(url, { credentials: "same-origin" });
          if (!response.ok) throw new Error(tr("Ce fichier n’a pas pu être ouvert.", "This file could not be opened.", "تعذر فتح هذا الملف."));
          text = await response.text();
        }
      }
      setDevicePreview({ attachment, file: session?.file || { name: attachment.name }, url, text, local: Boolean(session) });
    } catch (error) {
      notify(error.message || tr("Ce fichier n’a pas pu être ouvert.", "This file could not be opened.", "تعذر فتح هذا الملف."));
    }
  }
  async function sendMessage(event) {
    event?.preventDefault();
    if (composerDisabled || (!draft.trim() && !attachments.length)) return;
    const targetChannel = channel;
    const targetScope = currentScope.current;
    let queued = false;
    setSending(true);
    setAttachmentError("");
    try {
      const files = attachments.map(attachment => {
        const session = getSessionFile(attachment.id);
        if (!session && !attachment.resourceId) throw new Error(tr("Sélectionnez à nouveau ce fichier avant de l’envoyer.", "Select this file again before sending.", "اختر هذا الملف مجدداً قبل إرساله."));
        return { ...attachment, file: session?.file };
      });
      autoFollow.current = true;
      const delivery = publishMessage({
        client_id: createMessageId(),
        content: draft.trim(),
        channel: targetChannel,
        replyTo: replyTo?.id || null,
        attachments: files,
      });
      queued = true;
      setDrafts(previous => ({ ...previous, [targetChannel]: "" }));
      setReplyTo(null);
      setAttachmentDrafts(previous => ({ ...previous, [targetChannel]: [] }));
      for (const attachment of attachments) releaseSessionAttachment(attachment.id);
      setSending(false);
      setShowSearch(false);
      setQuery("");
      if (requestedMessage) setParams({ channel: targetChannel }, { replace: true });
      requestAnimationFrame(() => {
        scrollLatest(motion());
        composerRef.current?.focus();
      });
      await delivery;
    } catch (error) {
      if (!queued && targetScope === currentScope.current) setAttachmentError(error.message || tr("Le message n’a pas pu être envoyé. Réessayez.", "The message could not be sent. Try again.", "تعذر إرسال الرسالة. حاول مجدداً."));
    } finally {
      if (targetScope === currentScope.current) setSending(false);
    }
  }
  function reply(message) {
    setReplyTo(message);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function mention(message) {
    const username =
      message.username || message.author.toLowerCase().replace(/\s+/g, ".");
    setDraft(
      (previous) =>
        `${previous}${previous && !previous.endsWith(" ") ? " " : ""}@${username} `,
    );
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function isOwn(message) {
    return message.authorId ? String(message.authorId) === String(user.id) : message.username === user.username;
  }
  function hasReaction(message, kind) {
    return (message.myReactions || message.my_reactions)?.includes(kind) || (Array.isArray(message.reactions?.[kind]) && message.reactions[kind].includes(user.username));
  }
  function reactionCount(message, kind) {
    const value = message.reactions?.[kind];
    return Array.isArray(value) ? value.length : Number(value) || 0;
  }
  async function toggleReaction(message, kind) {
    try { await toggleMessageReaction(message.id, kind); }
    catch (error) { notify(error.message); }
  }
  async function copyMessageLink(message) {
    const link = new URL("/app/community", window.location.origin);
    link.searchParams.set("channel", normalizedChannel(message.channel));
    link.searchParams.set("message", message.id);
    try {
      await copyText(link.href);
      notify(tr("Lien copié.", "Link copied.", "تم نسخ الرابط."));
    } catch {
      notify(tr("Le lien n’a pas pu être copié. Réessayez.", "The link could not be copied. Try again.", "تعذر نسخ الرابط. حاول مرة أخرى."));
    }
  }
  async function copyMessageText(message) {
    try {
      await copyText(message.content);
      notify(tr("Message copié.", "Message copied.", "تم نسخ الرسالة."));
    } catch {
      notify(tr("Le message n’a pas pu être copié. Réessayez.", "The message could not be copied. Try again.", "تعذر نسخ الرسالة. حاول مرة أخرى."), 'error');
    }
  }
  async function deleteMessage(message) {
    if (!isOwn(message) && !isAdmin) return;
    try {
      await removeMessage(message.id);
      if (replyTo?.id === message.id) setReplyTo(null);
      if (requestedMessage === message.id) setParams({ channel }, { replace: true });
      notify(tr("Message supprimé.", "Message deleted.", "تم حذف الرسالة."));
    } catch (error) { notify(error.message); }
  }
  function openAttachment(message) {
    const resource = resources.find(item => item.id === message.attachment?.resourceId);
    if (resource) openDocument(resource);
    else notify(tr("Ce document n’est plus disponible dans votre bibliothèque.", "This document is no longer available in your library.", "لم تعد هذه الوثيقة متاحة في مكتبتكم."));
  }
  async function togglePin(message) {
    try {
      await toggleMessagePin(message.id);
      notify(tr(message.pinned ? "Message désépinglé." : "Message épinglé.", message.pinned ? "Message unpinned." : "Message pinned.", message.pinned ? "تم إلغاء تثبيت الرسالة." : "تم تثبيت الرسالة."));
    } catch (error) { notify(error.message); }
  }
  async function submitReport(event) {
    event.preventDefault();
    if (!reportReason || mutationBusy) return;
    setMutationBusy(true);
    try {
      await reportMessage({ messageId: report.id, reason: reportReason, details: reportDetails.trim() });
      setReport(null);
      setReportReason("");
      setReportDetails("");
      notify(tr("Signalement transmis à l’administration.", "Report sent to administration.", "تم إرسال البلاغ إلى الإدارة."));
    } catch (error) { notify(error.message); }
    finally { setMutationBusy(false); }
  }
  async function promoteMessage(event) {
    event.preventDefault();
    if (!promotionTitle.trim() || mutationBusy) return;
    setMutationBusy(true);
    try {
      await publishAnnouncement({ messageId: promotion.id, title: promotionTitle.trim() });
      setPromotion(null);
      setPromotionTitle("");
      notify(tr("Discussion publiée dans les annonces.", "Discussion published in announcements.", "تم نشر المناقشة في الإعلانات."));
    } catch (error) { notify(error.message); }
    finally { setMutationBusy(false); }
  }
  function dateLabel(date) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today))
      return tr("Aujourd’hui", "Today", "اليوم");
    if (dayKey(date) === dayKey(yesterday))
      return tr("Hier", "Yesterday", "أمس");
    return new Date(date).toLocaleDateString(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Africa/Casablanca",
    });
  }
  function actionsFor(message, promoted) {
    if (message.deliveryStatus) return [];
    const saved = isSaved("discussion", message.id);
    return [
      {
        key: "reply",
        label: tr("Répondre", "Reply", "رد"),
        icon: Reply,
        run: () => reply(message),
      },
      {
        key: "mention",
        label: tr("Mentionner", "Mention", "ذكر"),
        icon: AtSign,
        run: () => mention(message),
      },
      {
        key: "save",
        label: saved
          ? tr(
              "Retirer des enregistrements",
              "Remove from saved",
              "إزالة من المحفوظات",
            )
          : tr("Enregistrer la discussion", "Save discussion", "حفظ المناقشة"),
        icon: saved ? Check : Bookmark,
        run: () => saveItem("discussion", message.id),
      },
      ...(isAdmin
        ? [
            {
              key: "pin",
              label: tr(
                message.pinned ? "Désépingler" : "Épingler",
                message.pinned ? "Unpin" : "Pin",
                message.pinned ? "إلغاء التثبيت" : "تثبيت",
              ),
              icon: Pin,
              run: () => togglePin(message),
            },
            {
              key: "promote",
              label: tr(
                "Publier une annonce",
                "Publish announcement",
                "نشر إعلان",
              ),
              icon: Megaphone,
              disabled: promoted,
              run: () => {
                setPromotion(message);
                setPromotionTitle("");
              },
            },
          ]
        : []),
      {
        key: "copy-text",
        label: tr("Copier le message", "Copy message", "نسخ الرسالة"),
        icon: Copy,
        disabled: !message.content,
        run: () => copyMessageText(message),
      },
      {
        key: "copy",
        label: tr("Copier le lien", "Copy link", "نسخ الرابط"),
        icon: LinkIcon,
        run: () => copyMessageLink(message),
      },
      {
        key: "report",
        label: tr("Signaler", "Report", "إبلاغ"),
        icon: Flag,
        run: () => {
          setReport(message);
          setReportReason("");
          setReportDetails("");
        },
      },
      ...(isOwn(message) || isAdmin ? [{
        key: "delete",
        label: tr("Supprimer le message", "Delete message", "حذف الرسالة"),
        icon: Trash2,
        danger: true,
        run: () => deleteMessage(message),
      }] : []),
    ];
  }

  return (
    <div
      className="community-page"
      data-mobile-view={mobileConversation ? "conversation" : "channels"}
    >
      <div className="community-layout">
        <ChannelNavigation
          {...{
            channel,
            changeChannel,
            faculty,
            filiere,
            messages,
            tr,
          }}
        />
        <section className="community-chat" aria-label={channelLabel}>
          <header className="community-chat-header">
            <button
              ref={mobileBackRef}
              className="community-mobile-back"
              type="button"
              aria-label={tr("Tous les canaux", "All channels", "جميع القنوات")}
              onClick={backToChannels}
            >
              <ArrowLeft size={21} />
            </button>
            <div className="community-chat-heading">
              <h2>
                <Hash size={19} />
                <span>{channelLabel}</span>
              </h2>
              <p title={channelDescription}>{channelSummary}</p>
            </div>
            <div className="community-header-tools">
              <button
                ref={searchTriggerRef}
                type="button"
                className={`community-header-button ${showSearch ? "active" : ""}`}
                aria-label={tr(
                  "Rechercher dans la conversation",
                  "Search conversation",
                  "البحث في المحادثة",
                )}
                aria-expanded={showSearch}
                onClick={() => {
                  setShowSearch((previous) => !previous);
                  setQuery("");
                }}
              >
                <Search size={18} />
                <span className="community-tool-label">
                  {tr("Rechercher", "Search", "بحث")}
                </span>
              </button>
              <button
                type="button"
                className="community-header-button"
                aria-label={tr(
                  "Messages épinglés",
                  "Pinned messages",
                  "الرسائل المثبتة",
                )}
                onClick={() => setShowPins(true)}
              >
                <Pin size={17} />
                <span className="community-tool-label">
                  {tr("Épinglés", "Pinned", "المثبتة")}
                </span>
                <span className="community-pin-count" aria-hidden="true">
                  {pins.length}
                </span>
              </button>
            </div>
          </header>
          {showSearch && (
            <div className="community-search-bar">
              <Search size={17} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr(
                  "Rechercher un message ou un étudiant…",
                  "Search messages or students…",
                  "ابحث عن رسالة أو طالب…",
                )}
                aria-label={tr(
                  "Rechercher dans la conversation",
                  "Search conversation",
                  "البحث في المحادثة",
                )}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setShowSearch(false);
                    setQuery("");
                    searchTriggerRef.current?.focus();
                  }
                }}
              />
              <span aria-live="polite">
                {needle &&
                  tr(
                    `${visibleMessages.length} résultat${visibleMessages.length === 1 ? "" : "s"}`,
                    `${visibleMessages.length} result${visibleMessages.length === 1 ? "" : "s"}`,
                    `${visibleMessages.length} نتيجة`,
                  )}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={tr(
                  "Fermer la recherche",
                  "Close search",
                  "إغلاق البحث",
                )}
                onClick={() => {
                  setShowSearch(false);
                  setQuery("");
                  searchTriggerRef.current?.focus();
                }}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <div className="community-history-wrap">
            <div
              className="community-message-history"
              ref={historyRef}
              role="log"
              tabIndex={0}
              aria-label={tr(
                "Historique des messages",
                "Message history",
                "سجل الرسائل",
              )}
              aria-live="polite"
              onScroll={() => {
                const node = historyRef.current;
                const nearBottom =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 65;
                autoFollow.current = nearBottom;
                setShowLatest(!nearBottom && !needle);
              }}
            >
              {!visibleMessages.length ? (
                <EmptyState
                  icon={needle ? Search : MessageCircle}
                  title={
                    needle
                      ? tr(
                          "Aucun message trouvé",
                          "No messages found",
                          "لم يتم العثور على رسائل",
                        )
                      : tr(
                          "La discussion commence avec vous",
                          "The conversation starts with you",
                          "المناقشة تبدأ معكم",
                        )
                  }
                  description={
                    needle
                      ? tr(
                          "Essayez un autre mot ou le nom d’un étudiant.",
                          "Try another word or a student’s name.",
                          "جرّب كلمة أخرى أو اسم طالب.",
                        )
                      : tr(
                          "Une question sur ce semestre ? Une ressource à partager ? Votre filière est là pour échanger.",
                          "A question about this semester? A resource to share? Your program is here to talk.",
                          "سؤال حول هذا الفصل؟ مورد للمشاركة؟ زملاؤكم هنا للتواصل.",
                        )
                  }
                  action={
                    <Button
                      onClick={() => {
                        if (needle) {
                          setQuery("");
                          searchRef.current?.focus();
                        } else composerRef.current?.focus();
                      }}
                    >
                      {needle
                        ? tr(
                            "Effacer la recherche",
                            "Clear search",
                            "مسح البحث",
                          )
                        : tr(
                            "Écrire le premier message",
                            "Write the first message",
                            "اكتب أول رسالة",
                          )}
                    </Button>
                  }
                />
              ) : (
                <div className="community-message-list">
                  {visibleMessages.map((message, index) => {
                    const previous = visibleMessages[index - 1];
                    const showDate =
                      !previous ||
                      dayKey(previous.date) !== dayKey(message.date);
                    const grouped =
                      !needle &&
                      !showDate &&
                      previous?.author === message.author &&
                      accountName(previous?.username) === accountName(message.username) &&
                      new Date(message.date) - new Date(previous.date) <
                        5 * 60 * 1000 &&
                      !message.pinned;
                    const referenceId = typeof message.replyTo === "object" ? message.replyTo?.id : message.replyTo;
                    const referenced = currentMessages.find(item => item.id === referenceId);
                    const own = isOwn(message);
                    const promoted = announcements.some(
                      (item) => item.messageId === message.id,
                    );
                    return (
                      <React.Fragment key={message.id}>
                        {showDate && (
                          <div className="community-date-divider">
                            <span>{dateLabel(message.date)}</span>
                          </div>
                        )}
                        <MessageActions
                          className={`community-message ${own ? "is-own" : ""} ${grouped ? "is-grouped" : ""} ${message.pinned ? "is-pinned" : ""} ${message.id === highlight ? "is-highlighted" : ""} ${message.deliveryStatus ? `is-${message.deliveryStatus}` : ''}`}
                          id={message.id}
                          data-message-id={message.id}
                          data-delivery-status={message.deliveryStatus}
                          aria-busy={message.deliveryStatus === 'sending'}
                          label={tr('Actions du message', 'Message actions', 'إجراءات الرسالة')}
                          actions={actionsFor(message, promoted)}
                          quickActions={message.deliveryStatus ? [] : [
                            { key: 'like', label: tr('Utile', 'Helpful', 'مفيد'), icon: ThumbsUp, active: hasReaction(message, 'like'), run: () => toggleReaction(message, 'like') },
                            { key: 'heart', label: tr('J’aime', 'Love', 'أعجبني'), icon: Heart, active: hasReaction(message, 'heart'), run: () => toggleReaction(message, 'heart') },
                          ]}
                        >
                          <div className="community-message-avatar">
                            {grouped ? (
                              <time
                                className="community-group-time"
                                dateTime={message.date}
                              >
                                {new Date(message.date).toLocaleTimeString(
                                  locale,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    timeZone: "Africa/Casablanca",
                                  },
                                )}
                              </time>
                            ) : (
                              <Avatar name={message.author} size="sm" />
                            )}
                          </div>
                          <div className="community-message-body">
                            {!grouped && (
                              <div className="community-message-meta">
                                <strong dir="auto">{message.author}</strong>
                                {own && (
                                  <span className="community-you">
                                    {tr("vous", "you", "أنت")}
                                  </span>
                                )}
                                <time dateTime={message.date}>
                                  {new Date(message.date).toLocaleTimeString(
                                    locale,
                                    {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      timeZone: "Africa/Casablanca",
                                    },
                                  )}
                                </time>
                                {message.pinned && (
                                  <span className="community-message-pinned">
                                    <Pin size={11} />
                                    {tr("Épinglé", "Pinned", "مثبت")}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="community-message-bubble">
                            {referenced && (
                              <button
                                className="community-reply-reference"
                                type="button"
                                onClick={() => jumpToMessage(referenced.id)}
                              >
                                <Reply size={13} />
                                <strong dir="auto">{referenced.author}</strong>
                                <span dir="auto">{messagePreview(referenced)}</span>
                              </button>
                            )}
                            {message.content && <MessageContent query={query}>
                              {message.content}
                            </MessageContent>}
                            {message.attachment && (
                              <div className="community-message-attachment">
                                <button className="community-attachment-file" type="button" onClick={() => openAttachment(message)}>
                                  <span className="community-attachment-icon"><FileText size={22} /></span>
                                  <span className="community-attachment-copy">
                                    <strong dir="auto">{message.attachment.title}</strong>
                                    <small>{message.attachment.size || "PDF"}</small>
                                  </span>
                                  <ArrowUpRight size={16} />
                                </button>
                                <RouterLink className="community-attachment-context" to={`/app/library?${new URLSearchParams({ semester: String(message.attachment.semester), module: message.attachment.module, category: message.attachment.category })}`}>
                                  <BookOpen size={12} />
                                  <span dir="auto">{t(message.attachment.category)} · S{message.attachment.semester} · {message.attachment.module}</span>
                                  <ArrowUpRight size={12} />
                                </RouterLink>
                              </div>
                            )}
                            {(message.attachments || []).map(file => <div className="community-message-attachment community-device-attachment" key={file.id}>
                              <button className="community-attachment-file" type="button" disabled={Boolean(message.deliveryStatus)} onClick={() => openDeviceAttachment(file)}>
                                <span className="community-attachment-icon"><FileText size={22} /></span>
                                <span className="community-attachment-copy"><strong dir="auto">{file.title || file.name}</strong>{file.title && file.title !== file.name && <small className="community-file-name" dir="auto">{file.name}</small>}<AttachmentClassification attachment={file} /><small>{file.fileType} · {file.size}</small>{file.path?.includes('/') && <small dir="auto">{file.path}</small>}<small className="community-device-availability">{file.url ? tr("Fichier enregistré", "Saved file", "ملف محفوظ") : tr("Fichier sélectionné", "Selected file", "ملف محدد")}</small></span>
                                <ArrowUpRight size={16} />
                              </button>
                            </div>)}
                            </div>
                            {message.deliveryStatus && <div className={`community-delivery-status is-${message.deliveryStatus}`} role={message.deliveryStatus === 'failed' ? 'alert' : 'status'} aria-live="polite">
                              {message.deliveryStatus === 'sending' ? <><LoaderCircle size={12}/><span>{message.attachments?.length ? tr('Envoi des fichiers et du message…', 'Sending files and message…', 'جارٍ إرسال الملفات والرسالة…') : tr('Envoi…', 'Sending…', 'جارٍ الإرسال…')}</span></> : <><span>{message.deliveryError || tr('Échec de l’envoi.', 'Message was not sent.', 'لم تُرسل الرسالة.')}</span><button type="button" onClick={() => retryMessage(message.id).catch(() => {})}><RotateCcw size={12}/> {tr('Réessayer', 'Retry', 'إعادة المحاولة')}</button><button type="button" onClick={() => discardMessage(message.id)}><X size={12}/> {tr('Retirer', 'Remove', 'إزالة')}</button></>}
                            </div>}
                            {own && referenced && <span className="community-message-reply-note"><Reply size={13} />{tr("Réponse", "Reply", "رد")}</span>}
                            {(["like", "heart"]).some(kind => reactionCount(message, kind) > 0) && (
                              <div className="community-message-reactions">
                                {[{kind: "like", icon: ThumbsUp, label: tr("Utile", "Helpful", "مفيد")}, {kind: "heart", icon: Heart, label: tr("J’aime", "Love", "أعجبني")}].map(({kind, icon: Icon, label}) => reactionCount(message, kind) > 0 && (
                                  <button key={kind} type="button" className={`community-reaction ${hasReaction(message, kind) ? "is-active" : ""}`} aria-label={`${label} · ${reactionCount(message, kind)}`} aria-pressed={hasReaction(message, kind)} onClick={() => toggleReaction(message, kind)}>
                                    <Icon size={13} fill={kind === "heart" && hasReaction(message, kind) ? "currentColor" : "none"} />
                                    <span>{reactionCount(message, kind)}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                            {promoted && (
                              <span className="community-promoted">
                                <Megaphone size={13} />
                                {tr(
                                  "Également dans les annonces",
                                  "Also in announcements",
                                  "منشور أيضاً في الإعلانات",
                                )}
                              </span>
                            )}
                          </div>
                        </MessageActions>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
            {showLatest && (
              <button
                type="button"
                className="community-latest-button"
                onClick={() => scrollLatest(motion())}
              >
                <ArrowDown size={14} />
                {tr("Derniers messages", "Latest messages", "أحدث الرسائل")}
              </button>
            )}
          </div>
          <form className="community-composer" onSubmit={sendMessage} onDragOver={event => event.preventDefault()} onDrop={dropDeviceFiles}>
            {replyTo && (
              <div className="community-composer-reply">
                <Reply size={16} />
                <div>
                  <span>
                    {tr("Réponse à", "Replying to", "الرد على")}{" "}
                    <strong dir="auto">{replyTo.author}</strong>
                  </span>
                  <p dir="auto">{messagePreview(replyTo)}</p>
                </div>
                <button
                  type="button"
                  aria-label={tr(
                    "Annuler la réponse",
                    "Cancel reply",
                    "إلغاء الرد",
                  )}
                  onClick={() => setReplyTo(null)}
                >
                  <X size={17} />
                </button>
              </div>
            )}
            <input ref={fileInputRef} className="community-device-file-input" type="file" accept={SUPPORTED_FILE_ACCEPT} multiple hidden onChange={selectDeviceFiles} aria-label={tr("Choisir des fichiers pour le chat", "Choose chat files", "اختيار ملفات للدردشة")} />
            <input ref={folderInputRef} className="community-device-folder-input" type="file" accept={SUPPORTED_FILE_ACCEPT} multiple webkitdirectory="" directory="" hidden onChange={selectDeviceFiles} aria-label={tr("Choisir un dossier pour le chat", "Choose a chat folder", "اختيار مجلد للدردشة")} />
            {attachments.length > 0 && <div className="community-composer-attachments" aria-label={tr("Fichiers sélectionnés", "Selected files", "الملفات المختارة")}>
              {attachments.map(file => <div className="community-composer-attachment" key={file.id}>
                <FileText size={19} />
                <div><button className="community-device-draft-preview" type="button" onClick={() => openDeviceAttachment(file)} aria-label={tr(`Aperçu ${file.name}`, `Preview ${file.name}`, `معاينة ${file.name}`)}><strong dir="auto">{file.title || file.name}</strong>{file.title && file.title !== file.name && <small className="community-file-name" dir="auto">{file.name}</small>}<AttachmentClassification attachment={file} /><small>{file.fileType} · {file.size}</small>{file.path?.includes('/') && <small dir="auto">{file.path}</small>}</button></div>
                <button type="button" disabled={sending} onClick={() => removeDeviceAttachment(file.id)} aria-label={tr(`Retirer ${file.name}`, `Remove ${file.name}`, `إزالة ${file.name}`)}><X size={17} /></button>
              </div>)}
            </div>}
            {unavailableReason && <p className="community-attachment-error" role="status">{unavailableReason}</p>}{attachmentError && <p className="community-attachment-error" role="alert">{attachmentError}</p>}
            <div className="community-composer-input">
              <AttachmentPicker key={channel} {...{fileInputRef, folderInputRef, tr}} disabled={composerDisabled} />
              <textarea
                ref={composerRef}
                value={draft}
                disabled={composerDisabled}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={tr(
                  'Votre message…',
                  'Your message…',
                  'رسالتك…',
                )}
                aria-label={tr("Votre message", "Your message", "رسالتكم")}
                rows={1}
                maxLength={3000}
                dir="auto"
              />
              <Button
                variant="primary"
                type="submit"
                disabled={composerDisabled || (!draft.trim() && !attachments.length)}
                aria-busy={sending}
                icon={Send}
                aria-label={tr(
                  "Envoyer le message",
                  "Send message",
                  "إرسال الرسالة",
                )}
              />
            </div>
            <div className="community-composer-help" id="community-message-actions-hint">
              <span>
                {tr(
                  'Appui long sur un message pour les actions',
                  'Hold a message to see its actions',
                  'اضغط مطوّلاً على رسالة لعرض الإجراءات',
                )}
              </span>
            </div>
          </form>
        </section>
      </div>
      {attachmentClassification && <UploadModal mode="chat" initialEntries={attachmentClassification.entries} existingAttachments={attachmentClassification.existingAttachments} onConfirm={confirmDeviceFiles} onClose={() => setAttachmentClassification(null)} />}
      {devicePreview && <Modal className="community-device-preview" title={devicePreview.attachment.title || devicePreview.attachment.name} onClose={() => setDevicePreview(null)} wide footer={<Button variant="primary" icon={Download} onClick={() => { const link = document.createElement('a'); link.href = devicePreview.attachment.downloadUrl || devicePreview.url; link.download = devicePreview.attachment.name || devicePreview.file.name; link.click(); }}>{tr("Télécharger", "Download", "تنزيل")}</Button>}>
        <p className="muted community-device-preview-meta">{devicePreview.attachment.fileType} · {devicePreview.attachment.size} · {devicePreview.local ? tr("Fichier sélectionné sur votre appareil", "File selected on your device", "ملف محدد من جهازك") : tr("Fichier conservé dans cette discussion", "File saved in this conversation", "ملف محفوظ في هذه المناقشة")}</p>
        {devicePreview.attachment.module && <dl className="community-device-details">
          {[
            [tr('Fichier', 'File', 'الملف'), devicePreview.attachment.name],
            [tr('Faculté', 'Faculty', 'الكلية'), devicePreview.attachment.facultyName],
            [tr('Filière', 'Program', 'المسلك'), devicePreview.attachment.filiereName],
            [t('semester'), `S${devicePreview.attachment.semester}`],
            [t('module'), devicePreview.attachment.module],
            [tr('Catégorie', 'Category', 'الفئة'), t(devicePreview.attachment.category)],
            [tr('Part/Chapitre', 'Part/Chapitre', 'جزء/فصل'), partLabel(devicePreview.attachment.part, language)],
            [tr('Professeur / auteur', 'Professor / author', 'الأستاذ / المؤلف'), devicePreview.attachment.author],
            [tr('Partagé par', 'Shared by', 'شارك بواسطة'), devicePreview.attachment.uploader],
            [tr('Date', 'Date', 'التاريخ'), devicePreview.attachment.date && new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(devicePreview.attachment.date))],
          ].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd dir="auto">{value}</dd></div>)}
        </dl>}
        {devicePreview.attachment.path?.includes('/') && <p className="muted community-device-preview-path" dir="auto">{devicePreview.attachment.path}</p>}
        {devicePreview.attachment.fileType === 'PDF' ? <iframe className="community-device-pdf" title={devicePreview.attachment.name} src={devicePreview.url + '#toolbar=0&view=FitH'} /> : ['JPG', 'JPEG', 'PNG', 'WEBP'].includes(devicePreview.attachment.fileType) ? <img className="community-device-image" src={devicePreview.url} alt={devicePreview.attachment.name} /> : devicePreview.attachment.fileType === 'TXT' ? <pre className="community-device-text" dir="auto">{devicePreview.text}</pre> : <EmptyState icon={FileText} title={devicePreview.attachment.name} description={tr("Téléchargez ce fichier pour l’ouvrir avec une application compatible sur votre appareil.", "Download this file to open it in a compatible application on your device.", "نزّل الملف لفتحه بتطبيق متوافق على جهازك.")} />}
      </Modal>}
      {showPins && (
        <Modal
          className="community-pins-modal"
          title={tr("Messages épinglés", "Pinned messages", "الرسائل المثبتة")}
          onClose={() => setShowPins(false)}
        >
          <p className="community-pins-intro">
            {channelLabel} ·{" "}
            {tr(
              "Les messages à garder à portée de main.",
              "Messages to keep close.",
              "الرسائل التي تستحق المتابعة.",
            )}
          </p>
          {pins.length ? (
            <div className="community-pin-list">
              {pins.map((message) => (
                <div key={message.id} className="community-pin-item">
                  <div className="community-pin-meta">
                    <Avatar name={message.author} size="sm" />
                    <strong dir="auto">{message.author}</strong>
                    <time>{dateLabel(message.date)}</time>
                  </div>
                  <MessageContent>{messagePreview(message)}</MessageContent>
                  <button
                    className="text-link"
                    type="button"
                    onClick={() => jumpToMessage(message.id)}
                  >
                    {tr(
                      "Voir dans la conversation",
                      "View in conversation",
                      "عرض في المحادثة",
                    )}
                    <ArrowLeft size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Pin}
              title={tr(
                "Aucun message épinglé",
                "No pinned messages",
                "لا توجد رسائل مثبتة",
              )}
              description={tr(
                "L’administration peut épingler les échanges utiles à votre filière.",
                "Administrators can pin useful conversations for your program.",
                "يمكن للإدارة تثبيت المناقشات المفيدة لمسلككم.",
              )}
            />
          )}
        </Modal>
      )}
      {report && (
        <Modal
          title={tr(
            "Signaler un message",
            "Report a message",
            "الإبلاغ عن رسالة",
          )}
          onClose={() => setReport(null)}
          footer={
            <>
              <Button onClick={() => setReport(null)}>
                {tr("Annuler", "Cancel", "إلغاء")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="report-message-form"
                disabled={!reportReason || mutationBusy}
                aria-busy={mutationBusy}
              >
                {mutationBusy ? tr('Envoi…', 'Sending…', 'جارٍ الإرسال…') : tr("Envoyer le signalement", "Submit report", "إرسال البلاغ")}
              </Button>
            </>
          }
        >
          <form
            id="report-message-form"
            onSubmit={submitReport}
            className="stack"
          >
            <p className="muted">
              {tr(
                "Ce signalement sera transmis à l’administration pour examen.",
                "This report will be sent to administration for review.",
                "سيُرسل هذا البلاغ إلى الإدارة للمراجعة.",
              )}
            </p>
            <blockquote className="community-modal-quote" dir="auto">
              {messagePreview(report)}
            </blockquote>
            <Field label={tr("Motif", "Reason", "السبب")}>
              <Select
                className="input"
                value={reportReason}
                onChange={(event) => setReportReason(event.target.value)}
                required
              >
                <option value="">
                  {tr("Choisir un motif", "Choose a reason", "اختر سبباً")}
                </option>
                <option value="inappropriate">
                  {tr(
                    "Contenu inapproprié",
                    "Inappropriate content",
                    "محتوى غير ملائم",
                  )}
                </option>
                <option value="spam">
                  {tr(
                    "Spam ou publicité",
                    "Spam or advertising",
                    "رسائل مزعجة أو إعلانات",
                  )}
                </option>
                <option value="harassment">
                  {tr("Harcèlement", "Harassment", "تحرش")}
                </option>
                <option value="other">{tr("Autre", "Other", "آخر")}</option>
              </Select>
            </Field>
            <Field
              label={tr(
                "Précisions (facultatif)",
                "Details (optional)",
                "تفاصيل (اختياري)",
              )}
            >
              <textarea
                className="input"
                value={reportDetails}
                onChange={(event) => setReportDetails(event.target.value)}
                rows={3}
                maxLength={1000}
              />
            </Field>
          </form>
        </Modal>
      )}
      {promotion && (
        <Modal
          title={tr(
            "Faire de cette discussion une annonce",
            "Turn this discussion into an announcement",
            "تحويل المناقشة إلى إعلان",
          )}
          onClose={() => setPromotion(null)}
          footer={
            <>
              <Button onClick={() => setPromotion(null)}>
                {tr("Annuler", "Cancel", "إلغاء")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="promote-message-form"
                disabled={!promotionTitle.trim() || mutationBusy}
                aria-busy={mutationBusy}
                icon={Megaphone}
              >
                {mutationBusy ? tr('Publication…', 'Publishing…', 'جارٍ النشر…') : tr(
                  "Publier l’annonce",
                  "Publish announcement",
                  "نشر الإعلان",
                )}
              </Button>
            </>
          }
        >
          <form
            id="promote-message-form"
            onSubmit={promoteMessage}
            className="stack"
          >
            <p className="muted">
              {tr(
                "Une annonce épinglée sera visible par les étudiants de cette filière, avec un lien vers la discussion.",
                "A pinned announcement will be visible to students in this program, with a link to the discussion.",
                "سيظهر إعلان مثبت لطلبة هذا المسلك مع رابط إلى المناقشة.",
              )}
            </p>
            <Field
              label={tr(
                "Titre de l’annonce",
                "Announcement title",
                "عنوان الإعلان",
              )}
            >
              <input
                className="input"
                value={promotionTitle}
                onChange={(event) => setPromotionTitle(event.target.value)}
                required
                maxLength={140}
              />
            </Field>
            <blockquote className="community-modal-quote" dir="auto">
              {messagePreview(promotion)}
            </blockquote>
            <Badge>{channelLabel}</Badge>
          </form>
        </Modal>
      )}
    </div>
  );
}
