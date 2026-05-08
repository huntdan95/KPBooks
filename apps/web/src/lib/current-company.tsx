import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'kpbooks.currentCompanyId';

interface CurrentCompany {
  companyId: string | null;
  setCompanyId: (id: string | null) => void;
}

const Ctx = createContext<CurrentCompany>({
  companyId: null,
  setCompanyId: () => undefined,
});

export function CurrentCompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  useEffect(() => {
    if (companyId) localStorage.setItem(STORAGE_KEY, companyId);
    else localStorage.removeItem(STORAGE_KEY);
  }, [companyId]);

  return (
    <Ctx.Provider value={{ companyId, setCompanyId: setCompanyIdState }}>{children}</Ctx.Provider>
  );
}

export function useCurrentCompany(): CurrentCompany {
  return useContext(Ctx);
}
