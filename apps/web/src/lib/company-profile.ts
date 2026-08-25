/**
 * Whose books this is — the block every report leads with.
 *
 * QuickBooks puts the company on top of the report, not in the chrome around
 * it, because the report is the thing that gets printed, emailed and filed.
 * One hook so the on-screen header, the CSV header block and the PDF masthead
 * can never disagree about the name on the page.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useCurrentCompany } from './current-company';

export interface CompanyAddress {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface CompanyProfile {
  name: string;
  legalName: string | null;
  ein: string | null;
  phone: string | null;
  address: CompanyAddress | null;
}

interface CompanyResponse {
  name: string;
  legalName?: string | null;
  ein?: string | null;
  phone?: string | null;
  address?: CompanyAddress | null;
}

export function useCompanyProfile(): CompanyProfile {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  // Same query key Period Close and Mileage use, so this reads their cached
  // company instead of firing a request of its own.
  const query = useQuery({
    queryKey: ['company-current', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<CompanyResponse>('/companies/current', { companyId }),
  });

  /**
   * /companies/current is the better source but nothing waits on it — a report
   * renders as soon as the REPORT resolves, and a 4xx on that request never
   * retries — so leaning on it alone puts a blank name at the top of the page,
   * which is the one thing this block exists to prevent. The membership list is
   * guaranteed: the whole shell is gated on ['me'] before any report can render.
   */
  const fallbackName = (): string => {
    const me = queryClient.getQueryData<{
      memberships?: Array<{ companyId: string; companyName: string }>;
    }>(['me']);
    return me?.memberships?.find((m) => m.companyId === companyId)?.companyName ?? '';
  };

  const data = query.data;
  return {
    name: data?.name || fallbackName(),
    legalName: data?.legalName ?? null,
    ein: data?.ein ?? null,
    phone: data?.phone ?? null,
    address: data?.address ?? null,
  };
}

/**
 * The address as it goes on a letterhead: street lines first, then one
 * "City, ST 78701" line. Every part is optional — a company that has filled in
 * nothing but a name gets no address lines at all rather than a row of commas.
 */
export function companyAddressLines(address: CompanyAddress | null): string[] {
  if (!address) return [];
  const lines: string[] = [];
  if (address.street1) lines.push(address.street1);
  if (address.street2) lines.push(address.street2);
  const cityState = [address.city, address.state].filter(Boolean).join(', ');
  const locality = [cityState, address.postalCode].filter(Boolean).join(' ');
  if (locality) lines.push(locality);
  // Country only when it is not the implied one — "United States" on every
  // report of a US-only book is noise.
  const country = address.country?.trim();
  if (country && !/^(us|usa|united states)$/i.test(country)) lines.push(country);
  return lines;
}

/**
 * The contact line under the address: phone and EIN, separated by a middot.
 * `einLabel` arrives already translated so this stays free of i18n.
 */
export function companyContactLine(profile: CompanyProfile, einLabel: string): string {
  return [profile.phone, profile.ein ? `${einLabel} ${profile.ein}` : null]
    .filter(Boolean)
    .join(' · ');
}
