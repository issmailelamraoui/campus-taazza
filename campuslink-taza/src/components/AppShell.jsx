import { Select } from './Select';
import React, { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Home,
  BookOpen,
  MessageSquare,
  Megaphone,
  Bell,
  Bookmark,
  UserRound,
  ShieldCheck,
  Search,
  Sun,
  Moon,
  ChevronsUpDown,
  ChevronRight,
  Menu,
  X,
  ArrowRight,
  HelpCircle,
  LogOut,
  Lock,
  CheckCheck,
  LoaderCircle,
} from "lucide-react";
import { useApp } from "../context";
import { Logo, Avatar, Button } from "./ui";
import { NotificationItem } from "../pages/StudentPages";
export default function AppShell() {
  const {
    t,
    tr,
    user,
    faculty,
    filiere,
    selection,
    notifications,
    theme,
    setTheme,
    language,
    setLanguage,
    setDialog,
    logout,
    markAllRead,
    isAdmin,
    connectionError,
    refresh,
    networkActivity = { reads: 0, writes: 0 },
  } = useApp();
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notificationTab, setNotificationTab] = useState('unread');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const panelRef = useRef(null);
  const menuRef = useRef(null);
  const drawerRef = useRef(null);
  const nav = [
    ["home", "/app", Home],
    ["library", "/app/library", BookOpen],
    ["community", "/app/community", MessageSquare],
    ["announcements", "/app/announcements", Megaphone],
    ["notifications", "/app/notifications", Bell],
    ["saved", "/app/saved", Bookmark],
    ["profile", "/app/profile", UserRound],
    ...(isAdmin ? [["admin", "/app/admin", ShieldCheck]] : []),
  ];
  const mobileNav = [nav[0], nav[2], nav[1], nav[3]];
  const mobileNavLabel = (key) =>
    key === "community" ? tr("Discussions", "Discussions", "النقاشات") : t(key);
  const current = nav.find((x) => x[1] === location.pathname)?.[0] || "home";
  const unread = notifications.filter((n) => !n.read).length;
  const panelNotifications = notifications.filter(n => notificationTab === 'read' ? n.read : !n.read);
  useEffect(() => {
    setDrawer(false);
    setPanel(false);
    setMenu(false);
    document.title = `${t(current)} · CampusLink Taza`;
  }, [location.pathname, language]);
  useEffect(() => {
    function handler(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog({ type: "search" });
      }
      if (e.key === "Escape") {
        setDrawer(false);
        setPanel(false);
        setMenu(false);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setDialog]);
  useEffect(() => {
    function outside(e) {
      if (
        panel &&
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        !e.target.closest(".notification-button")
      )
        setPanel(false);
      if (
        menu &&
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        !e.target.closest(".header-avatar")
      )
        setMenu(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [panel, menu]);
  useEffect(() => {
    if (!drawer) return;
    const prev = document.activeElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const node = drawerRef.current;
    node?.querySelector("button")?.focus();
    function trap(e) {
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll("a,button")].filter(
        (x) => x.getClientRects().length,
      );
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    node?.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = old;
      node?.removeEventListener("keydown", trap);
      prev?.focus();
    };
  }, [drawer]);
  return (
    <div
      className={`app-shell ${location.pathname.replace(/\/$/, "") === "/app/community" ? "app-shell--community" : ""}`}
    >
      <a href="#main-content" className="skip-link">
        {tr("Aller au contenu", "Skip to content", "انتقل إلى المحتوى")}
      </a>
      <div
        className={`drawer-overlay ${drawer ? "open" : ""}`}
        onClick={() => setDrawer(false)}
      />
      <aside
        ref={drawerRef}
        className={`sidebar ${drawer ? "open" : ""}`}
        aria-label={tr(
          "Navigation principale",
          "Main navigation",
          "التنقل الرئيسي",
        )}
      >
        <button
          className="icon-btn sidebar-mobile-close"
          aria-label={t("close")}
          onClick={() => setDrawer(false)}
        >
          <X size={19} />
        </button>
        <Link to="/app" aria-label="CampusLink Taza">
          <Logo />
        </Link>
        <div className="sidebar-context">
          <span className="context-mark">
            <BookOpen size={16} />
          </span>
          <div className="context-copy">
            <strong>
              {faculty?.code}
              <span className="muted"> · S{selection?.semester}</span>
            </strong>
            <p dir="auto" title={filiere?.name}>
              {filiere?.name}
            </p>
          </div>
          <Lock
            size={11}
            className="muted"
            style={{ marginInlineStart: "auto" }}
            aria-label={t("locked")}
          />
        </div>
        <p className="sidebar-label">
          {tr("VOTRE CAMPUS", "YOUR CAMPUS", "حرمك الجامعي")}
        </p>
        <nav>
          {nav.map(([key, path, Icon], i) => (
            <React.Fragment key={key}>
              {i === 4 && <div className="nav-divider" />}
              <NavLink
                aria-label={t(key)}
                title={t(key)}
                onClick={() => setDrawer(false)}
                end={key === "home"}
                to={path}
                className={({ isActive }) =>
                  `nav-item ${i < 4 ? "mobile-primary-nav-link" : ""} ${isActive ? "active" : ""}`
                }
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>{t(key)}</span>
                {key === "notifications" && unread > 0 && (
                  <span className="nav-count">{unread}</span>
                )}
              </NavLink>
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <strong>
              {tr(
                "On est là pour vous.",
                "We’re here to help.",
                "نحن هنا لمساعدتك.",
              )}
            </strong>
            <p>
              {tr(
                "Une question sur votre compte ?",
                "A question about your account?",
                "سؤال حول حسابك؟",
              )}
            </p>
            <button onClick={() => setDialog({ type: "contact" })}>
              {t("contact")}
              <ArrowRight size={11} />
            </button>
          </div>
          <Link
            to="/app/profile"
            className="sidebar-user"
            onClick={() => setDrawer(false)}
          >
            <Avatar name={user.name} src={user.avatar} />
            <span>
              {user.name}
              <small>
                {isAdmin
                  ? tr(
                      "Compte administrateur",
                      "Administrator account",
                      "حساب الإدارة",
                    )
                  : tr(
                      "Compte étudiant",
                      "Student account",
                      "حساب طالب",
                    )}
              </small>
            </span>
            <ChevronsUpDown size={13} className="muted" />
          </Link>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <button
            className="icon-btn mobile-menu-button"
            aria-label={t("menu")}
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu size={21} />
          </button>
          <div className="header-breadcrumb">
            <span>Campus</span>
            <ChevronRight size={13} className="muted" />
            <span>{t(current)}</span>
          </div>
          <div className="header-actions">
            {networkActivity.writes > 0 && <span className="app-write-status" role="status" aria-live="polite"><LoaderCircle size={13}/>{tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…')}</span>}
            <button
              className="global-search-button"
              onClick={() => setDialog({ type: "search" })}
              aria-label={t("search")}
            >
              <Search size={15} />
              <span>
                {tr(
                  "Rechercher dans CampusLink",
                  "Search CampusLink",
                  "ابحث في CampusLink",
                )}
              </span>
              <kbd className="key-hint">⌘ K</kbd>
            </button>
            <button
              className="icon-btn notification-button"
              aria-label={`${t("notifications")} (${unread})`}
              aria-expanded={panel}
              onClick={() => {
                setPanel(!panel);
                setNotificationTab('unread');
                setMenu(false);
              }}
            >
              <Bell size={18} strokeWidth={1.7} />
              {unread > 0 && <span className="notification-dot">{unread}</span>}
            </button>
            <Select
              className="language-select"
              aria-label={t("language")}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="fr">FR</option>
              <option value="en">EN</option>
              <option value="ar">عربي</option>
            </Select>
            <button
              className="icon-btn"
              aria-label={t("theme")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun size={18} strokeWidth={1.6} />
              ) : (
                <Moon size={18} strokeWidth={1.6} />
              )}
            </button>
            <span className="header-separator" />
            <button
              className="icon-btn header-avatar"
              aria-label={t("account")}
              aria-expanded={menu}
              onClick={() => {
                setMenu(!menu);
                setPanel(false);
              }}
            >
              <Avatar name={user.name} size="sm" src={user.avatar} />
            </button>
          </div>
          {panel && (
            <section
              ref={panelRef}
              className="notification-popover"
              aria-label={t("notifications")}
            >
              <div className="notification-popover-header">
                <h2>{t("notifications")}</h2>
                <button
                  className="icon-btn"
                  title={t("markAllRead")}
                  aria-label={t("markAllRead")}
                  disabled={!unread || readBusy}
                  aria-busy={readBusy}
                  onClick={async () => { setReadBusy(true); try { await markAllRead(); } catch {} finally { setReadBusy(false); } }}
                >
                  {readBusy ? <LoaderCircle size={17}/> : <CheckCheck size={17} />}
                </button>
              </div>
              <div className="notification-filter-tabs" aria-label={tr('Filtrer les notifications', 'Filter notifications', 'تصفية الإشعارات')}>
                <button type="button" aria-pressed={notificationTab === 'unread'} onClick={() => setNotificationTab('unread')}>{t('unread')} ({unread})</button>
                <button type="button" aria-pressed={notificationTab === 'read'} onClick={() => setNotificationTab('read')}>{t('read')}</button>
              </div>
              {panelNotifications.slice(0, 3).map((n) => (
                <NotificationItem key={n.id} notification={n} />
              ))}
              {!panelNotifications.length && <p className="notification-popover-empty" role="status">{notificationTab === 'read' ? tr('Aucune notification lue.', 'No read notifications.', 'لا توجد إشعارات مقروءة.') : tr('Aucune notification non lue.', 'No unread notifications.', 'لا توجد إشعارات غير مقروءة.')}</p>}
              <footer>
                <Link
                  className="text-link"
                  to="/app/notifications"
                  onClick={() => setPanel(false)}
                >
                  {tr(
                    "Voir toutes les notifications",
                    "View all notifications",
                    "عرض كل الإشعارات",
                  )}
                  <ArrowRight size={13} />
                </Link>
              </footer>
            </section>
          )}
          {menu && (
            <div
              ref={menuRef}
              className="user-popover"
              style={{
                position: "absolute",
                top: 65,
                insetInlineEnd: 30,
                width: 220,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 12,
                boxShadow: "var(--shadow)",
              }}
            >
              <div
                style={{
                  padding: "7px 10px 13px",
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 13 }}>{user.name}</strong>
                <p className="muted" style={{ fontSize: 11 }}>
                  @{user.username}
                </p>
              </div>
              <Link className="nav-item" to="/app/profile">
                <UserRound size={16} />
                {t("profile")}
              </Link>
              <button
                className="nav-item"
                style={{ width: "100%", background: "none" }}
                disabled={logoutBusy}
                aria-busy={logoutBusy}
                onClick={async () => {
                  setLogoutBusy(true);
                  try { await logout(); navigate("/login"); } catch {} finally { setLogoutBusy(false); }
                }}
              >
                <LogOut size={16} />
                {logoutBusy ? tr('Déconnexion…', 'Signing out…', 'جارٍ تسجيل الخروج…') : t("logout")}
              </button>
            </div>
          )}
        </header>
        <div className="academic-context-bar">
          <strong>
            {faculty?.code} · S{selection?.semester}
          </strong>
          <span>·</span>
          <bdi>{filiere?.name}</bdi>
          <Lock size={10} aria-label={t("locked")} />
        </div>
        <main
          id="main-content"
          className="content"
          aria-label={t(current)}
          tabIndex={-1}
        >
          {connectionError && <div className="notice" role="alert" style={{marginBottom:16}}><span>{connectionError}</span> <button className="text-link" onClick={()=>refresh().catch(()=>{})}>{tr("Réessayer", "Retry", "إعادة المحاولة")}</button></div>}
          <Outlet />
        </main>
        <footer className="app-footer">
          <span className="footer-demo">
            <span className="footer-dot" />
            {tr("Votre campus, connecté.", "Your campus, connected.", "حرمك الجامعي متصل.")}
          </span>
          <span>
            CampusLink Taza <span style={{ marginInline: 8 }}>·</span>{" "}
            {tr(
              "Apprendre. Partager. Avancer.",
              "Learn. Share. Grow.",
              "تعلّم. شارك. تقدّم.",
            )}
          </span>
        </footer>
      </div>
      <nav
        className="mobile-bottom-nav"
        aria-label={tr("Navigation rapide", "Quick navigation", "التنقل السريع")}
      >
        {mobileNav.map(([key, path, Icon]) => (
          <NavLink
            key={key}
            end={key === "home"}
            to={path}
            title={mobileNavLabel(key)}
            aria-label={mobileNavLabel(key)}
            className={({ isActive }) =>
              `mobile-bottom-nav-link ${isActive ? "active" : ""}`
            }
          >
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            <span>{mobileNavLabel(key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
