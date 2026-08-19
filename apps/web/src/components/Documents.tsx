import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useRef, type DragEvent, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { EmptyState } from './ui/EmptyState';
import { Icon, type IconName } from './ui/Icon';

type Category =
  | 'tax_return'
  | 'w9'
  | 'w2'
  | 'form_1099'
  | 'form_941'
  | 'receipt'
  | 'statement'
  | 'contract'
  | 'correspondence'
  | 'financial_report'
  | 'other';

interface DocumentRow {
  id: string;
  category: Category;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string;
  description: string | null;
  tags: string[];
  taxYear: number | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  uploadedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ListResp {
  documents: DocumentRow[];
}

const MAX_BYTES = 10 * 1024 * 1024;

const CATEGORY_OPTIONS: Array<{ value: Category; labelKey: string; icon: IconName }> = [
  { value: 'tax_return', labelKey: 'documents.category.taxReturn', icon: 'file-text' },
  { value: 'w9', labelKey: 'documents.category.w9', icon: 'badge-check' },
  { value: 'w2', labelKey: 'documents.category.w2', icon: 'badge-check' },
  { value: 'form_1099', labelKey: 'documents.category.form1099', icon: 'badge-check' },
  { value: 'form_941', labelKey: 'documents.category.form941', icon: 'badge-check' },
  { value: 'receipt', labelKey: 'documents.category.receipt', icon: 'receipt' },
  { value: 'statement', labelKey: 'documents.category.statement', icon: 'banknote' },
  { value: 'contract', labelKey: 'documents.category.contract', icon: 'file-text' },
  { value: 'correspondence', labelKey: 'documents.category.correspondence', icon: 'inbox' },
  {
    value: 'financial_report',
    labelKey: 'documents.category.financialReport',
    icon: 'bar-chart',
  },
  { value: 'other', labelKey: 'documents.category.other', icon: 'package' },
];

const CATEGORY_LABEL_KEY: Record<Category, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((c) => [c.value, c.labelKey]),
) as Record<Category, string>;

const CATEGORY_TONE: Record<Category, string> = {
  tax_return: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  w9: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  w2: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  form_1099: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  form_941: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  receipt: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  statement: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  contract: 'bg-slate-100 text-slate-700 ring-slate-300',
  correspondence: 'bg-slate-100 text-slate-700 ring-slate-300',
  financial_report: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  other: 'bg-slate-100 text-slate-600 ring-slate-300',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function fileToBase64(file: File, readError: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(readError));
        return;
      }
      // result is "data:<mime>;base64,XXXX". Strip prefix.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(readError));
    reader.readAsDataURL(file);
  });
}

export function Documents() {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<'' | Category>('');
  const [taxYear, setTaxYear] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingCategory, setPendingCategory] = useState<Category>('receipt');
  const [pendingTaxYear, setPendingTaxYear] = useState<string>('');

  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (taxYear) params.set('taxYear', taxYear);
  if (search.trim()) params.set('q', search.trim());

  const documentsQ = useQuery({
    queryKey: ['documents', companyId, category, taxYear, search],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<ListResp>(`/documents${params.toString() ? `?${params.toString()}` : ''}`, {
        companyId,
      }),
  });

  const docs = documentsQ.data?.documents ?? [];
  const editingDoc = editingId ? docs.find((d) => d.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {t('documents.title')}
        </h2>
        <p className="text-sm text-slate-500">{t('documents.blurb')}</p>
      </div>

      {/* Upload zone */}
      <UploadZone
        defaultCategory={pendingCategory}
        defaultTaxYear={pendingTaxYear}
        onCategoryChange={setPendingCategory}
        onTaxYearChange={setPendingTaxYear}
        onUploaded={() => {
          void queryClient.invalidateQueries({ queryKey: ['documents', companyId] });
        }}
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
        <Field label={t('documents.fields.category')}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as '' | Category)}
            className={inputClass}
          >
            <option value="">{t('documents.allCategories')}</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.labelKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('documents.fields.taxYear')}>
          <input
            type="number"
            min={1990}
            max={2100}
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value)}
            placeholder={t('documents.placeholders.taxYear')}
            className={inputClass + ' w-28'}
          />
        </Field>
        <Field label={t('documents.fields.search')}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('documents.placeholders.search')}
            className={inputClass + ' min-w-[240px]'}
          />
        </Field>
        {(category || taxYear || search) && (
          <button
            type="button"
            onClick={() => {
              setCategory('');
              setTaxYear('');
              setSearch('');
            }}
            className="self-end rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            {t('documents.clearFilters')}
          </button>
        )}
        <div className="ml-auto self-end text-xs text-slate-500">
          {t('documents.count', { count: docs.length })}
        </div>
      </div>

      {documentsQ.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {documentsQ.isError && (
        <p className="text-sm text-rose-600">
          {documentsQ.error instanceof Error ? documentsQ.error.message : t('failedToLoad')}
        </p>
      )}

      {!documentsQ.isLoading && docs.length === 0 && (
        <EmptyState
          icon="upload-cloud"
          title={
            category || taxYear || search
              ? t('documents.emptyFilteredTitle')
              : t('documents.emptyTitle')
          }
          description={
            category || taxYear || search
              ? t('documents.emptyFilteredDescription')
              : t('documents.emptyDescription')
          }
        />
      )}

      {docs.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">
                  {t('documents.columns.filename')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('documents.columns.category')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('documents.columns.taxYear')}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t('documents.columns.size')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('documents.columns.uploaded')}
                </th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="text-slate-900">{d.filename}</div>
                    {d.description && (
                      <div className="text-xs text-slate-500 line-clamp-1">{d.description}</div>
                    )}
                    {d.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {d.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ' +
                        CATEGORY_TONE[d.category]
                      }
                    >
                      {t(CATEGORY_LABEL_KEY[d.category])}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {d.taxYear ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-600">
                    {formatBytes(d.fileSizeBytes)}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">{formatDate(d.createdAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <DownloadButton id={d.id} filename={d.filename} />
                      <button
                        type="button"
                        onClick={() => setEditingId(d.id)}
                        className="text-xs text-slate-600 hover:text-slate-900 hover:underline"
                      >
                        {t('common:edit')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingDoc && (
        <EditDocumentModal doc={editingDoc} onClose={() => setEditingId(null)} />
      )}
    </div>
  );
}

// --- Upload zone -----------------------------------------------------------

function UploadZone({
  defaultCategory,
  defaultTaxYear,
  onCategoryChange,
  onTaxYearChange,
  onUploaded,
}: {
  defaultCategory: Category;
  defaultTaxYear: string;
  onCategoryChange: (c: Category) => void;
  onTaxYearChange: (y: string) => void;
  onUploaded: () => void;
}) {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]); // filenames
  const [errors, setErrors] = useState<Array<{ filename: string; message: string }>>([]);
  const [successCount, setSuccessCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadOne(file: File): Promise<void> {
    if (file.size === 0) {
      throw new Error(t('documents.errors.emptyFile'));
    }
    if (file.size > MAX_BYTES) {
      throw new Error(t('documents.errors.tooLarge', { max: formatBytes(MAX_BYTES) }));
    }
    const base64 = await fileToBase64(file, t('documents.errors.readFailed'));
    const body: Record<string, unknown> = {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileBase64: base64,
      category: defaultCategory,
    };
    if (defaultTaxYear) body.taxYear = Number(defaultTaxYear);
    await api('/documents', { method: 'POST', companyId, body });
  }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setErrors([]);
    setSuccessCount(0);
    setUploading(list.map((f) => f.name));
    let okCount = 0;
    const errs: Array<{ filename: string; message: string }> = [];
    for (const file of list) {
      try {
        await uploadOne(file);
        okCount++;
      } catch (err) {
        errs.push({
          filename: file.name,
          message:
            err instanceof ApiError
              ? (err.body as { message?: string } | null)?.message ?? `HTTP ${err.status}`
              : err instanceof Error
                ? err.message
                : t('documents.errors.uploadFailed'),
        });
      }
    }
    setUploading([]);
    setSuccessCount(okCount);
    setErrors(errs);
    if (okCount > 0) onUploaded();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      void handleFiles(e.target.files);
      // Reset so picking the same file twice still fires onChange.
      e.target.value = '';
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('documents.fields.uploadAs')}>
          <select
            value={defaultCategory}
            onChange={(e) => onCategoryChange(e.target.value as Category)}
            className={inputClass}
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.labelKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('documents.fields.taxYearOptional')}>
          <input
            type="number"
            min={1990}
            max={2100}
            value={defaultTaxYear}
            onChange={(e) => onTaxYearChange(e.target.value)}
            placeholder={t('documents.placeholders.year')}
            className={inputClass + ' w-28'}
          />
        </Field>
        <p className="self-end text-xs text-slate-500">{t('documents.defaultsHint')}</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ' +
          (dragOver
            ? 'border-emerald-400 bg-emerald-50/40'
            : 'border-slate-300 bg-slate-50/40 hover:bg-slate-50')
        }
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon name="upload-cloud" className="h-5 w-5" />
        </div>
        <div className="text-sm font-medium text-slate-900">
          {t('documents.dragFiles')}{' '}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-emerald-700 underline hover:text-emerald-900"
          >
            {t('documents.clickToPick')}
          </button>
        </div>
        <p className="text-xs text-slate-500">{t('documents.uploadHint')}</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onPick}
          className="hidden"
        />
      </div>

      {uploading.length > 0 && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {t('documents.uploading', { count: uploading.length })}
        </div>
      )}
      {successCount > 0 && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('documents.uploaded', { count: successCount })}
        </div>
      )}
      {errors.length > 0 && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {t('documents.uploadsFailed', { count: errors.length })}
          <ul className="mt-1 list-disc pl-5 text-xs">
            {errors.map((e, i) => (
              <li key={i}>
                <strong>{e.filename}</strong>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Download button -------------------------------------------------------

function DownloadButton({ id, filename }: { id: string; filename: string }) {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const [downloading, setDownloading] = useState(false);

  async function go() {
    setDownloading(true);
    try {
      const token = await getIdToken();
      const res = await fetch(`${getApiBase()}/documents/${id}/download`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={downloading}
      className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 hover:underline disabled:opacity-50"
    >
      <Icon name="upload-cloud" className="h-3 w-3 rotate-180" />
      {downloading ? t('documents.downloading') : t('common:download')}
    </button>
  );
}

// --- Edit modal ------------------------------------------------------------

function EditDocumentModal({
  doc,
  onClose,
}: {
  doc: DocumentRow;
  onClose: () => void;
}) {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [filename, setFilename] = useState(doc.filename);
  const [category, setCategory] = useState<Category>(doc.category);
  const [description, setDescription] = useState(doc.description ?? '');
  const [tagsInput, setTagsInput] = useState(doc.tags.join(', '));
  const [taxYear, setTaxYear] = useState<string>(doc.taxYear ? String(doc.taxYear) : '');

  const updateMut = useMutation({
    mutationFn: async () => {
      const tags = tagsInput
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        filename,
        category,
        description: description.trim() || null,
        tags,
        taxYear: taxYear ? Number(taxYear) : null,
      };
      return api(`/documents/${doc.id}`, { method: 'PATCH', companyId, body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents', companyId] });
      onClose();
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () =>
      api(`/documents/${doc.id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents', companyId] });
      onClose();
    },
  });

  return (
    <div
      className="kpb-fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kpb-pop-in my-8 w-full max-w-xl space-y-3 rounded-lg border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {t('documents.editTitle')}
            </h3>
            <p className="text-xs text-slate-500">
              {formatBytes(doc.fileSizeBytes)} · {doc.mimeType} ·{' '}
              {t('documents.uploadedOn', { date: formatDate(doc.createdAt) })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:close')}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>

        <Field label={t('documents.fields.filename')} required>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            maxLength={255}
            required
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('documents.fields.category')} required>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              required
              className={inputClass}
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.labelKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('documents.fields.taxYear')}>
            <input
              type="number"
              min={1990}
              max={2100}
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label={t('documents.fields.description')}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
            className={inputClass}
          />
        </Field>
        <Field label={t('documents.fields.tags')}>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={t('documents.placeholders.tags')}
            className={inputClass}
          />
        </Field>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => {
              if (
                confirm(t('documents.confirmDelete'))
              ) {
                deleteMut.mutate();
              }
            }}
            disabled={deleteMut.isPending}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {deleteMut.isPending ? t('documents.deleting') : t('common:delete')}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={() => updateMut.mutate()}
              disabled={updateMut.isPending || !filename.trim()}
              className="whitespace-nowrap rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {updateMut.isPending ? t('documents.saving') : t('documents.saveChanges')}
            </button>
          </div>
        </div>
        {(updateMut.isError || deleteMut.isError) && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(updateMut.error ?? deleteMut.error, {
              error: t('shell:errors.label'),
              fallback: t('failed'),
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Bits ------------------------------------------------------------------

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}
