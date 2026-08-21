import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  FileBarChart2,
  KeyRound,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  Search,
  ShieldCheck,
  UserCog,
  UsersRound,
  WalletCards,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { EmployeeAccessState, EmployeeDetail, EmployeeListItem } from "@inmotion-crm/contracts";

import { AuthClient } from "../lib/auth";
import { cn } from "../lib/utils";
import { Alert } from "./ui/alert";

type EmployeeAccessScreenProps = {
  authClient: AuthClient;
  sessionId: string;
  onLogout: () => void;
  sessionWarning: React.ReactNode;
};

const emptyEmployees: EmployeeListItem[] = [];

const navigation = [
  { label: "Главная", icon: LayoutDashboard },
  { label: "Пациенты", icon: UsersRound },
  { label: "Расписание", icon: CalendarDays },
  { label: "Обращения", icon: Activity },
  { label: "Финансы", icon: WalletCards },
  { label: "Задачи", icon: ClipboardList },
  { label: "Отчёты", icon: FileBarChart2 },
] as const;

function statusLabel(employee: Pick<EmployeeListItem, "accessState" | "credentialState">): string {
  if (employee.accessState === "pending_activation") return "Не активирован";
  if (employee.accessState === "suspended") return "Приостановлен";
  if (employee.accessState === "security_quarantined") return "Проверка безопасности";
  if (employee.accessState === "terminated") return "Уволен";
  if (employee.credentialState === "temporary_password") return "Ожидает активации";
  return "Активен";
}

function statusTone(state: EmployeeAccessState): string {
  if (state === "active") return "bg-success";
  if (state === "pending_activation") return "bg-warning";
  if (state === "suspended" || state === "security_quarantined" || state === "terminated") return "bg-danger";
  return "bg-muted";
}

function initials(fullName: string): string {
  return fullName
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function formatLastSignIn(value: string | null): string {
  if (value === null) return "Нет входов";
  const date = new Date(value);
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function humanScope(scope: "own" | "assigned" | "all"): string {
  return scope === "all" ? "Все" : scope === "assigned" ? "Назначенные" : "Свои";
}

function humanPermission(code: string): string {
  const labels: Record<string, string> = {
    "contacts.read": "Контакты и запись",
    "schedule.read": "Просмотр расписания",
    "schedule.manage": "Просмотр и изменение",
    "payments.read": "Просмотр оплат",
    "payments.manage": "Принимать оплату",
    "medical.read.assigned": "Данные назначенных случаев",
    "medical.write.assigned": "Заполнение назначенных случаев",
    "employees.manage": "Управление сотрудниками",
    "employees.offboard": "Увольнение сотрудника",
    "roles.assign": "Назначение ролей",
  };
  return labels[code] ?? code;
}

export function EmployeeAccessScreen({ authClient, sessionId, onLogout, sessionWarning }: EmployeeAccessScreenProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<"profile" | "permissions" | "history">("permissions");

  const employeesQuery = useQuery({
    queryKey: ["employees", sessionId],
    queryFn: () => authClient.getEmployees(),
  });
  const employees = employeesQuery.data?.employees ?? emptyEmployees;
  const filteredEmployees = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    if (query === "") return employees;
    return employees.filter((employee) => `${employee.fullName} ${employee.login ?? ""} ${employee.roles.join(" ")}`.toLocaleLowerCase("ru-RU").includes(query));
  }, [employees, search]);

  const activeSelectedId = selectedId ?? employees[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ["employee", sessionId, activeSelectedId],
    queryFn: () => authClient.getEmployee(activeSelectedId!),
    enabled: activeSelectedId !== null && panelOpen,
  });

  const selected = detailQuery.data;
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="grid min-h-screen grid-cols-[240px_minmax(0,1fr)]">
        <aside className="flex min-h-screen flex-col bg-navy px-4 py-6 text-white" aria-label="Основная навигация">
          <div className="flex items-center gap-3 px-2 text-lg font-semibold tracking-tight">
            <span className="grid size-10 place-items-center rounded-xl bg-blue text-lg font-bold" aria-hidden="true">↗</span>
            <span>InMotion CRM</span>
          </div>
          <nav className="mt-10 space-y-1">
            {navigation.map(({ label, icon: Icon }) => (
              <a key={label} className="flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-white/80 transition hover:bg-white/10" href="#workspace">
                <Icon aria-hidden="true" size={20} />
                {label}
              </a>
            ))}
            <div className="mt-5 border-t border-white/15 pt-5">
              <div className="flex h-11 items-center gap-3 px-3 text-sm font-semibold text-white">
                <UserCog aria-hidden="true" size={20} />
                Администрирование
                <ChevronDown aria-hidden="true" className="ml-auto" size={16} />
              </div>
              <a aria-current="page" className="relative mt-1 flex h-11 items-center gap-3 rounded-lg bg-blue/15 px-3 text-sm font-semibold text-white before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-danger" href="#workspace">
                <UsersRound aria-hidden="true" size={20} />
                Сотрудники
              </a>
              <a className="flex h-10 items-center gap-3 px-3 text-sm text-white/80 hover:text-white" href="#workspace"><ShieldCheck aria-hidden="true" size={19} />Роли и права</a>
              <a className="flex h-10 items-center gap-3 px-3 text-sm text-white/80 hover:text-white" href="#workspace"><ClipboardList aria-hidden="true" size={19} />Аудит</a>
            </div>
          </nav>
          <button className="mt-auto flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-white/80 hover:bg-white/10 hover:text-white" onClick={onLogout} type="button">
            <PanelLeftClose aria-hidden="true" size={20} />Выйти
          </button>
        </aside>

        <main id="workspace" className="min-w-0">
          <header className="flex h-16 items-center gap-4 border-b border-line bg-surface px-8" aria-label="Контекст страницы">
            <label className="relative block max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={19} aria-hidden="true" />
              <input className="h-10 w-full rounded-lg border border-line bg-canvas pl-10 pr-3 text-sm outline-none ring-blue transition focus:ring-2" placeholder="Поиск по CRM" />
            </label>
            <button aria-label="Уведомления" className="relative grid size-11 place-items-center rounded-lg text-muted hover:bg-canvas" type="button">
              <Bell aria-hidden="true" size={20} />
              <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-blue text-[10px] font-semibold text-white">3</span>
            </button>
            <div className="flex items-center gap-2 border-l border-line pl-4">
              <span className="grid size-9 place-items-center rounded-full bg-blue/10 text-xs font-bold text-blue">CRM</span>
              <div className="hidden text-sm leading-tight sm:block"><p className="font-semibold">Текущая сессия</p><p className="text-xs text-muted">Защищённый доступ</p></div>
            </div>
          </header>

          <div className={cn("grid gap-5 p-6", panelOpen ? "grid-cols-[minmax(0,1fr)_minmax(440px,0.62fr)]" : "grid-cols-1")}>
            <section className="min-w-0">
              {sessionWarning}
              <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-2xl font-bold tracking-tight">Сотрудники и доступ</p>
                  <p className="mt-1 text-sm text-muted">Учётные записи, роли и рабочие обязанности команды.</p>
                </div>
                <button className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90" type="button">
                  <UsersRound size={18} aria-hidden="true" />Добавить сотрудника
                </button>
              </div>

              {employeesQuery.isError ? <Alert role="alert">Не удалось загрузить сотрудников. Повторите попытку позже.</Alert> : null}
              <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_14px_32px_rgb(15_43_79_/_0.06)]">
                <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
                  <label className="relative min-w-52 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={18} aria-hidden="true" />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue" placeholder="Найти сотрудника" />
                  </label>
                  <button className="h-10 rounded-lg border border-line px-3 text-sm font-medium" type="button">Все статусы <ChevronDown className="ml-2 inline" size={15} /></button>
                  <button className="h-10 rounded-lg border border-line px-3 text-sm font-medium" type="button">Все роли <ChevronDown className="ml-2 inline" size={15} /></button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-sm">
                    <thead className="border-b border-line bg-canvas/60 text-xs font-semibold text-muted">
                      <tr><th className="px-4 py-3">Сотрудник</th><th className="px-4 py-3">Роль</th><th className="px-4 py-3">Статус</th><th className="px-4 py-3">Последний вход</th><th className="px-4 py-3"><span className="sr-only">Действия</span></th></tr>
                    </thead>
                    <tbody>
                      {employeesQuery.isPending ? <tr><td className="px-4 py-10 text-center text-muted" colSpan={5}>Загружаем сотрудников…</td></tr> : null}
                      {!employeesQuery.isPending && filteredEmployees.length === 0 ? <tr><td className="px-4 py-10 text-center text-muted" colSpan={5}>Сотрудники не найдены.</td></tr> : null}
                      {filteredEmployees.map((employee) => <EmployeeRow key={employee.id} employee={employee} selected={employee.id === activeSelectedId} onSelect={() => { setSelectedId(employee.id); setPanelOpen(true); }} />)}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-line px-4 py-3 text-xs text-muted">Показано {filteredEmployees.length} из {employees.length} сотрудников</p>
              </div>
            </section>

            {panelOpen ? <EmployeeDetailPanel detail={selected} loading={detailQuery.isPending} error={detailQuery.isError} activeTab={activeTab} onTabChange={setActiveTab} onClose={() => setPanelOpen(false)} /> : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function EmployeeRow({ employee, selected, onSelect }: { employee: EmployeeListItem; selected: boolean; onSelect: () => void }) {
  return <tr className={cn("border-b border-line/80 last:border-0 transition hover:bg-blue/5", selected && "bg-blue/5 outline outline-1 -outline-offset-1 outline-blue") }>
    <td className="px-4 py-3"><button className="flex items-center gap-3 text-left" onClick={onSelect} type="button"><span className="grid size-9 place-items-center rounded-full bg-blue/10 text-xs font-bold text-blue">{initials(employee.fullName)}</span><span className="font-medium">{employee.fullName}</span></button></td>
    <td className="px-4 py-3 text-muted">{employee.roles.join(", ") || "Нет роли"}</td>
    <td className="px-4 py-3"><span className="inline-flex items-center gap-2"><span className={cn("size-2 rounded-full", statusTone(employee.accessState))} aria-hidden="true" />{statusLabel(employee)}</span></td>
    <td className="px-4 py-3 text-muted">{employee.temporaryPasswordExpiresAt !== null && employee.credentialState === "temporary_password" ? `Временный пароль до ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(new Date(employee.temporaryPasswordExpiresAt))}` : formatLastSignIn(employee.lastSignInAt)}</td>
    <td className="px-4 py-3 text-right"><button aria-label={`Действия для ${employee.fullName}`} className="grid size-9 place-items-center rounded-md text-muted hover:bg-canvas" onClick={onSelect} type="button"><Menu size={18} aria-hidden="true" /></button></td>
  </tr>;
}

function EmployeeDetailPanel({ detail, loading, error, activeTab, onTabChange, onClose }: { detail: EmployeeDetail | undefined; loading: boolean; error: boolean; activeTab: "profile" | "permissions" | "history"; onTabChange: (tab: "profile" | "permissions" | "history") => void; onClose: () => void }) {
  return <aside className="sticky top-6 flex max-h-[calc(100vh-112px)] min-h-[580px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_14px_32px_rgb(15_43_79_/_0.08)]" aria-label="Карточка сотрудника">
    <div className="border-b border-line px-6 py-5">
      <div className="flex items-start justify-between gap-3"><div>{loading ? <div className="h-7 w-48 animate-pulse rounded bg-canvas" /> : <><h2 className="text-xl font-bold">{detail?.fullName ?? "Сотрудник"}</h2><p className="mt-1 inline-flex items-center gap-2 text-sm text-success"><span className={cn("size-2 rounded-full", detail === undefined ? "bg-muted" : statusTone(detail.accessState))} />{detail === undefined ? "" : statusLabel(detail)}</p></>}</div><button className="grid size-10 place-items-center rounded-md text-muted hover:bg-canvas" onClick={onClose} type="button" aria-label="Закрыть карточку"><X size={20} aria-hidden="true" /></button></div>
      {detail !== undefined ? <div className="mt-4 grid gap-2 text-sm"><p className="flex gap-2"><ShieldCheck className="mt-0.5 shrink-0 text-muted" size={17} />{detail.roles.join(", ") || "Роль не назначена"}</p><p className="flex gap-2"><UserCog className="mt-0.5 shrink-0 text-muted" size={17} /><span><span className="text-muted">Логин</span><br />{detail.login ?? "—"}</span></p><p className="flex gap-2"><KeyRound className="mt-0.5 shrink-0 text-muted" size={17} /><span><span className="text-muted">Email для восстановления</span><br />{detail.recoveryEmail}</span></p></div> : null}
    </div>
    <div className="flex border-b border-line px-4" role="tablist" aria-label="Разделы карточки сотрудника">
      <Tab label="Профиль" active={activeTab === "profile"} onClick={() => onTabChange("profile")} />
      <Tab label="Роли и права" active={activeTab === "permissions"} onClick={() => onTabChange("permissions")} />
      <Tab label="История" active={activeTab === "history"} onClick={() => onTabChange("history")} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      {error ? <Alert role="alert">Не удалось загрузить карточку сотрудника.</Alert> : null}
      {loading ? <div className="space-y-4"><div className="h-24 animate-pulse rounded-xl bg-canvas" /><div className="h-56 animate-pulse rounded-xl bg-canvas" /></div> : null}
      {!loading && detail !== undefined && activeTab === "permissions" ? <Permissions detail={detail} /> : null}
      {!loading && detail !== undefined && activeTab === "profile" ? <p className="text-sm text-muted">Профиль сотрудника будет содержать реквизиты, состояние активации и безопасные действия учётной записи.</p> : null}
      {!loading && detail !== undefined && activeTab === "history" ? <p className="text-sm text-muted">История чувствительных изменений доступна только с соответствующим правом аудита.</p> : null}
    </div>
    {detail !== undefined ? <div className="flex flex-wrap gap-3 border-t border-line p-4"><button className="h-10 rounded-lg border border-blue px-3 text-sm font-semibold text-blue" type="button">Приостановить доступ</button><button className="ml-auto h-10 rounded-lg px-2 text-sm font-semibold text-danger" type="button">Оформить увольнение</button></div> : null}
  </aside>;
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button className={cn("relative h-12 px-3 text-sm font-medium text-muted", active && "text-blue after:absolute after:bottom-0 after:left-3 after:right-3 after:h-0.5 after:bg-blue")} onClick={onClick} role="tab" aria-selected={active} type="button">{label}</button>;
}

function Permissions({ detail }: { detail: EmployeeDetail }) {
  return <div className="space-y-5">
    <section><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold">Назначенные роли</h3><button className="text-sm font-semibold text-blue" type="button">Изменить</button></div><div className="rounded-xl border border-line p-3">{detail.assignedRoles.map((role) => <p className="flex items-start gap-2 text-sm" key={role.id}><UsersRound className="mt-0.5 text-muted" size={17} /><span><span className="font-semibold">{role.code}</span><br /><span className="text-xs text-muted">Источник: назначено вручную</span></span></p>)}</div></section>
    <section><h3 className="mb-2 text-sm font-bold">Итоговые права</h3><div className="overflow-hidden rounded-xl border border-line">{detail.effectivePermissions.length === 0 ? <p className="p-4 text-sm text-muted">Нет активных прав.</p> : detail.effectivePermissions.map((permission) => <div className="border-b border-line p-3 last:border-0" key={permission.permissionCode}><div className="flex justify-between gap-3 text-sm"><span className="font-semibold">{permission.resourceFamily}</span><span>{humanPermission(permission.permissionCode)}</span><span className="font-medium">{humanScope(permission.scope)}</span></div><p className="mt-1 text-xs text-muted">Источник: {permission.sourceLabel}{permission.expiresAt === null ? "" : ` · до ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(permission.expiresAt))}`}</p></div>)}</div></section>
    <section><h3 className="mb-2 text-sm font-bold">Индивидуальные исключения</h3>{detail.overrides.length === 0 ? <div className="rounded-xl border border-dashed border-line p-5 text-center text-sm text-muted"><ShieldCheck className="mx-auto mb-2" size={21} />Нет индивидуальных исключений<br /><button className="mt-2 font-semibold text-blue" type="button">Добавить исключение</button></div> : <div className="space-y-2">{detail.overrides.map((override) => <div className="rounded-lg border border-line p-3 text-sm" key={override.permissionCode}>{override.permissionCode}</div>)}</div>}</section>
  </div>;
}
