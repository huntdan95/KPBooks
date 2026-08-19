import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

// Namespaced resources: one JSON pair (en/es) per app area. Vite inlines
// these at build time — no runtime fetching, works offline, no CDN.
import enCommon from './locales/en/common.json';
import esCommon from './locales/es/common.json';
import enShell from './locales/en/shell.json';
import esShell from './locales/es/shell.json';
import enSales from './locales/en/sales.json';
import esSales from './locales/es/sales.json';
import enPurchases from './locales/en/purchases.json';
import esPurchases from './locales/es/purchases.json';
import enBanking from './locales/en/banking.json';
import esBanking from './locales/es/banking.json';
import enReports from './locales/en/reports.json';
import esReports from './locales/es/reports.json';
import enPayroll from './locales/en/payroll.json';
import esPayroll from './locales/es/payroll.json';

export type AppLanguage = 'en' | 'es';

const STORAGE_KEY = 'kpb:lang';

function detectLanguage(): AppLanguage {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'es') return stored;
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

const initial = detectLanguage();

void i18next.use(initReactI18next).init({
  lng: initial,
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'shell', 'sales', 'purchases', 'banking', 'reports', 'payroll'],
  resources: {
    en: {
      common: enCommon,
      shell: enShell,
      sales: enSales,
      purchases: enPurchases,
      banking: enBanking,
      reports: enReports,
      payroll: enPayroll,
    },
    es: {
      common: esCommon,
      shell: esShell,
      sales: esSales,
      purchases: esPurchases,
      banking: esBanking,
      reports: esReports,
      payroll: esPayroll,
    },
  },
  interpolation: {
    // React already escapes rendered strings.
    escapeValue: false,
  },
  returnEmptyString: false,
});

document.documentElement.lang = initial;

export function setLanguage(lang: AppLanguage): void {
  localStorage.setItem(STORAGE_KEY, lang);
  void i18next.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export function currentLanguage(): AppLanguage {
  return i18next.language === 'es' ? 'es' : 'en';
}

export default i18next;
