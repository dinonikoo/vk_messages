import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

type Gender = "М" | "Ж" | "";

interface Contact {
  fullName: string;
  firstName: string;
  gender: Gender;
  vkId: string;
  rawLink: string;
  status: "idle" | "sending" | "sent" | "error";
  errorMsg?: string;
}

function extractVkId(link: string): string | null {
  const trimmed = link.trim();
  const match = trimmed.match(/vk\.com\/id(\d+)/i);
  if (match) return match[1];
  const numericMatch = trimmed.match(/(\d+)/);
  if (numericMatch) return numericMatch[1];
  return null;
}

function parseGender(raw: string): Gender {
  const s = raw.trim().toUpperCase();
  if (s === "М" || s === "M") return "М";
  if (s === "Ж" || s === "F" || s === "W") return "Ж";
  return "";
}

// Parse and substitute placeholders in message for a specific contact
function processMessage(
  template: string,
  contact: Contact
): { text: string; error: string | null } {
  let result = template;

  // 1. Replace {имя}
  result = result.replace(/\{имя\}/gi, contact.firstName);

  // 2. Replace {М:value|Ж:value}
  const genderRegex = /\{М:([^|]*)\|Ж:([^}]*)\}/g;
  let hasInvalidPlaceholder = false;

  result = result.replace(genderRegex, (_match, maleVal: string, femaleVal: string) => {
    const g = contact.gender || "М"; // default to М if not set
    return g === "Ж" ? femaleVal : maleVal;
  });

  // 3. Check for remaining unclosed/malformed placeholders like {М:..} or {Ж:..} without proper format
  const leftoverBraces = result.match(/\{[^}]*\}/g);
  if (leftoverBraces) {
    for (const lb of leftoverBraces) {
      // Ignore if it doesn't look like our placeholders
      if (/\{(М|Ж|имя)/i.test(lb)) {
        hasInvalidPlaceholder = true;
      }
    }
  }

  // Also validate the template itself for malformed gender placeholders
  const malformedGender = template.match(/\{М:[^}]*\}/g);
  if (malformedGender) {
    for (const mg of malformedGender) {
      if (!/\{М:[^|]*\|Ж:[^}]*\}/.test(mg)) {
        hasInvalidPlaceholder = true;
      }
    }
  }

  if (hasInvalidPlaceholder) {
    return { text: "", error: "Некорректный плейсхолдер в сообщении. Формат: {М:значение|Ж:значение}" };
  }

  return { text: result, error: null };
}

// Validate that all placeholders in the template are well-formed (before sending)
function validateTemplate(template: string): string | null {
  // Check for {М:...} without proper |Ж:...}
  const allBraces = template.match(/\{[^}]*\}/g);
  if (!allBraces) return null;

  for (const b of allBraces) {
    const lower = b.toLowerCase();
    if (lower === "{имя}") continue;
    // Check if it looks like a gender placeholder attempt
    if (/\{М/i.test(b) || /\{Ж/i.test(b) || b.includes("|")) {
      if (!/^\{М:[^|]*\|Ж:[^}]*\}$/.test(b)) {
        return `Некорректный плейсхолдер: ${b}\nПравильный формат: {М:значение|Ж:значение}`;
      }
    }
  }
  return null;
}

// JSONP helper to bypass CORS
function jsonp(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const callbackName = `vk_cb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    (window as unknown as Record<string, unknown>)[callbackName] = (data: Record<string, unknown>) => {
      cleanup();
      resolve(data);
    };

    script.src = `${url}&callback=${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("Ошибка загрузки скрипта (сеть)"));
    };

    setTimeout(() => {
      cleanup();
      reject(new Error("Таймаут запроса"));
    }, 15000);

    document.body.appendChild(script);
  });
}

export function App() {
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [fileError, setFileError] = useState("");
  const [fileName, setFileName] = useState("");
  const [sendingAll, setSendingAll] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFileError("");
      setGlobalError("");
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);

      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
          });

          const startIdx =
            rows.length > 0 &&
            rows[0].some((cell) => {
              const s = String(cell ?? "").toLowerCase();
              return (
                s.includes("имя") ||
                s.includes("фамилия") ||
                s.includes("ссылка") ||
                s.includes("vk") ||
                s.includes("name") ||
                s.includes("link") ||
                s.includes("пол")
              );
            })
              ? 1
              : 0;

          const parsed: Contact[] = [];
          for (let i = startIdx; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 2) continue;
            const fullName = String(row[0] ?? "").trim();
            const link = String(row[1] ?? "").trim();
            const genderRaw = row.length >= 3 ? String(row[2] ?? "").trim() : "";
            if (!fullName && !link) continue;

            const firstName = fullName.split(/\s+/)[0] || "";
            const gender = parseGender(genderRaw);
            const vkId = extractVkId(link);

            if (vkId) {
              parsed.push({ fullName, firstName, gender, vkId, rawLink: link, status: "idle" });
            } else if (fullName || link) {
              parsed.push({
                fullName,
                firstName,
                gender,
                vkId: "—",
                rawLink: link,
                status: "error",
                errorMsg: "Не удалось извлечь ID",
              });
            }
          }

          if (parsed.length === 0) {
            setFileError(
              "Не найдено контактов. Убедитесь, что файл содержит столбцы: Имя Фамилия, Ссылка ВК, Пол (опционально)."
            );
          }
          setContacts(parsed);
        } catch (err) {
          console.error(err);
          setFileError("Ошибка при чтении файла. Проверьте формат (.xlsx / .xls).");
        }
      };
      reader.readAsArrayBuffer(file);
    },
    []
  );

  const updateContact = (index: number, updates: Partial<Contact>) => {
    setContacts((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...updates } : c))
    );
  };

  const removeContact = (index: number) => {
    setContacts((prev) => prev.filter((_, i) => i !== index));
  };

  const sendMessageToContact = useCallback(
    async (index: number, contact: Contact, msgTemplate: string) => {
      if (!token.trim()) return;
      if (!contact || contact.vkId === "—") return;

      // Process placeholders
      const { text, error } = processMessage(msgTemplate, contact);
      if (error) {
        updateContact(index, { status: "error", errorMsg: error });
        return;
      }

      updateContact(index, { status: "sending", errorMsg: undefined });

      try {
        const randomId = Math.floor(Math.random() * 2147483647);
        const params = new URLSearchParams({
          user_id: contact.vkId,
          message: text,
          random_id: String(randomId),
          access_token: token.trim(),
          v: "5.131",
        });

        const url = `https://api.vk.com/method/messages.send?${params.toString()}`;
        const result = await jsonp(url);

        if (result.error) {
          const errObj = result.error as Record<string, unknown>;
          updateContact(index, { status: "error", errorMsg: String(errObj.error_msg || "Ошибка API") });
        } else {
          updateContact(index, { status: "sent" });
        }
      } catch (err) {
        updateContact(index, {
          status: "error",
          errorMsg: err instanceof Error ? err.message : "Ошибка сети",
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  const sendMessage = (index: number) => {
    if (!token.trim()) {
      alert("Введите токен VK API");
      return;
    }
    if (!message.trim()) {
      alert("Введите текст сообщения");
      return;
    }
    setGlobalError("");
    const templateError = validateTemplate(message);
    if (templateError) {
      setGlobalError(templateError);
      return;
    }
    const contact = contacts[index];
    if (contact) {
      sendMessageToContact(index, contact, message);
    }
  };

  const toggleStatus = (index: number) => {
    setContacts((prev) =>
      prev.map((c, i) => {
        if (i !== index) return c;
        if (c.status === "sent" || c.status === "error")
          return { ...c, status: "idle" as const, errorMsg: undefined };
        return c;
      })
    );
  };

  const sendAll = useCallback(async () => {
    if (!token.trim()) {
      alert("Введите токен VK API");
      return;
    }
    if (!message.trim()) {
      alert("Введите текст сообщения");
      return;
    }
    setGlobalError("");
    const templateError = validateTemplate(message);
    if (templateError) {
      setGlobalError(templateError);
      return;
    }

    setSendingAll(true);

    const snapshot = [...contacts];
    for (let i = 0; i < snapshot.length; i++) {
      if (snapshot[i].vkId === "—" || snapshot[i].status === "sent") continue;
      await sendMessageToContact(i, snapshot[i], message);
      await new Promise((r) => setTimeout(r, 400));
    }

    setSendingAll(false);
  }, [contacts, sendMessageToContact, token, message]);

  const clearContacts = () => {
    setContacts([]);
    setFileName("");
    setFileError("");
    setGlobalError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const sentCount = contacts.filter((c) => c.status === "sent").length;
  const errorCount = contacts.filter((c) => c.status === "error").length;

  // Generate preview of processed message for a contact
  const getPreview = (contact: Contact): string => {
    if (!message.trim()) return "";
    const { text, error } = processMessage(message, contact);
    if (error) return `⚠ ${error}`;
    return text;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-blue-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-200">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Рассылка</h1>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Message & Token */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200/60 p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              📝 Текст сообщения
            </label>
            <textarea
              value={message}
              onChange={(e) => { setMessage(e.target.value); setGlobalError(""); }}
              placeholder={"Привет, {имя}! Ты хорошо потрудил{М:ся|Ж:ась}..."}
              rows={4}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none font-mono text-sm"
            />
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="bg-blue-50 text-blue-600 px-2 py-1 rounded-md font-mono">{"{"}<span className="font-bold">имя</span>{"}"}</span>
              <span>- подставляет имя контакта</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="bg-purple-50 text-purple-600 px-2 py-1 rounded-md font-mono">{"{"}<span className="font-bold">М:</span>значение<span className="font-bold">|Ж:</span>значение{"}"}</span>
              <span>- подставляет по полу (без пола по умолчанию подставляется значение для М)</span>
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Пример: <code className="bg-slate-100 px-1.5 py-0.5 rounded">Привет, {"{имя}"}! Ты хорошо потрудил{"{М:ся|Ж:ась}..."}</code>
            </div>
          </div>

          {globalError && (
            <div className="bg-red-50 text-red-600 text-sm rounded-lg px-4 py-3 border border-red-200 whitespace-pre-wrap">
              ⚠️ {globalError}
            </div>
          )}

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              🔑 Токен VK API
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Вставьте ваш access_token..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
            <p className="text-xs text-slate-400 mt-1">
              Токен с правами на отправку сообщений (messages).
            </p>
          </div>
        </section>

        {/* File Upload */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200/60 p-6">
          <label className="block text-sm font-semibold text-slate-700 mb-3">
            📄 Загрузка Excel-файла
          </label>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-xl font-medium text-sm hover:from-blue-600 hover:to-indigo-700 transition-all shadow-md shadow-blue-200 active:scale-95">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Выбрать файл
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
            {fileName && (
              <span className="text-sm text-slate-500 flex items-center gap-1.5">
                <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {fileName}
              </span>
            )}
            {contacts.length > 0 && (
              <button
                onClick={clearContacts}
                className="text-sm text-red-500 hover:text-red-600 underline underline-offset-2"
              >
                Очистить
              </button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Столбцы: <b>1</b> - Имя Фамилия, <b>2</b> - ссылка vk.com/id..., <b>3</b> — Пол (М/Ж, необязательно)
          </p>
          {fileError && (
            <div className="mt-3 bg-red-50 text-red-600 text-sm rounded-lg px-4 py-2 border border-red-100">
              ⚠️ {fileError}
            </div>
          )}
        </section>

        {/* Contacts List */}
        {contacts.length > 0 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200/60 overflow-hidden">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 flex-wrap">
                <h2 className="text-sm font-semibold text-slate-700">
                  Контакты: <span className="text-blue-600">{contacts.length}</span>
                </h2>
                {sentCount > 0 && (
                  <span className="text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
                    ✓ Отправлено: {sentCount}
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="text-xs bg-red-100 text-red-700 px-2.5 py-1 rounded-full font-medium">
                    ✗ Ошибки: {errorCount}
                  </span>
                )}
              </div>
              <button
                onClick={sendAll}
                disabled={sendingAll || !message.trim() || !token.trim()}
                className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium text-sm hover:from-green-600 hover:to-emerald-700 transition-all shadow-md shadow-green-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sendingAll ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Отправка...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    Отправить всем
                  </>
                )}
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10">№</th>
                    <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Имя Фамилия</th>
                    <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-28">Имя</th>
                    <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-16">Пол</th>
                    <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-24">VK ID</th>
                    <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Статус</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-36">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact, idx) => (
                    <tr
                      key={`${contact.vkId}-${idx}`}
                      className={`border-b border-slate-50 transition-colors ${
                        contact.status === "sent"
                          ? "bg-green-50/50"
                          : contact.status === "error"
                          ? "bg-red-50/50"
                          : "hover:bg-slate-50"
                      }`}
                    >
                      {/* № */}
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs">{idx + 1}</td>

                      {/* Имя Фамилия */}
                      <td className="px-3 py-3 font-medium text-slate-800 text-xs">{contact.fullName}</td>

                      {/* Имя (editable) */}
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={contact.firstName}
                          onChange={(e) => updateContact(idx, { firstName: e.target.value })}
                          className="w-full px-2 py-1 text-xs rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-slate-800"
                        />
                      </td>

                      {/* Пол */}
                      <td className="px-3 py-2">
                        <select
                          value={contact.gender}
                          onChange={(e) => updateContact(idx, { gender: e.target.value as Gender })}
                          className="w-full px-1 py-1 text-xs rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-slate-800"
                        >
                          <option value="">—</option>
                          <option value="М">М</option>
                          <option value="Ж">Ж</option>
                        </select>
                      </td>

                      {/* VK ID */}
                      <td className="px-3 py-3">
                        {contact.vkId !== "—" ? (
                          <a
                            href={`https://vk.com/id${contact.vkId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 font-mono text-xs bg-blue-50 px-2 py-1 rounded-md"
                          >
                            {contact.vkId}
                          </a>
                        ) : (
                          <span className="text-red-400 text-xs">—</span>
                        )}
                      </td>

                      {/* Статус */}
                      <td className="px-3 py-3">
                        <button
                          onClick={() => toggleStatus(idx)}
                          className="cursor-pointer hover:opacity-70 transition-opacity"
                          title={
                            contact.status === "sent" || contact.status === "error"
                              ? "Нажмите, чтобы сбросить статус"
                              : message.trim() ? `Превью: ${getPreview(contact)}` : undefined
                          }
                        >
                          {contact.status === "idle" && <span className="text-slate-400 text-xs">⏳ Ожидает</span>}
                          {contact.status === "sending" && (
                            <span className="text-amber-500 text-xs flex items-center gap-1">
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Отправка...
                            </span>
                          )}
                          {contact.status === "sent" && (
                            <span className="text-green-600 text-xs font-medium flex items-center gap-1">
                              ✅ Отправлено
                            </span>
                          )}
                          {contact.status === "error" && (
                            <span className="text-red-500 text-xs" title={contact.errorMsg}>
                              ❌ {contact.errorMsg?.slice(0, 40)}
                            </span>
                          )}
                        </button>
                      </td>

                      {/* Действия */}
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => sendMessage(idx)}
                            disabled={
                              contact.status === "sending" ||
                              contact.status === "sent" ||
                              contact.vkId === "—" ||
                              sendingAll
                            }
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                            </svg>
                            Отправить
                          </button>
                          <button
                            onClick={() => removeContact(idx)}
                            disabled={contact.status === "sending" || sendingAll}
                            className="inline-flex items-center justify-center w-7 h-7 text-red-400 hover:text-white hover:bg-red-500 rounded-lg transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Удалить"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Preview section */}
            {message.trim() && contacts.length > 0 && (
              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50">
                <p className="text-xs font-semibold text-slate-500 mb-2">👁 Превью сообщения (для первого контакта):</p>
                <div className="bg-white rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap font-mono">
                  {getPreview(contacts[0])}
                </div>
              </div>
            )}
          </section>
        )}

        {contacts.length === 0 && !fileError && (
          <div className="text-center py-16 text-slate-400">
            <svg className="w-16 h-16 mx-auto mb-4 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm">Загрузите Excel-файл, чтобы увидеть список контактов</p>
          </div>
        )}
      </main>
    </div>
  );
}
