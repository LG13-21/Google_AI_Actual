import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function reviewCourtRequest(text: string, selectedFiles: string[], selectedPillars: string[], supportFiles: string[] = [], instructions?: string, mode: 'AUDIT' | 'COMPOSE' | 'VERSION_DIFF' = 'AUDIT', compareVersions?: string[]) {
  const apiKey = process.env.GEMINI_API_KEY || (process.env as any).API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API key is missing. Please check your settings.");
  }
  
  const ai = new GoogleGenAI({ apiKey });

  try {
    const pillarsList = selectedPillars.join(", ");
    
    let systemPrompt = "";
    if (mode === 'AUDIT') {
      systemPrompt = `Jste JURISREVIEW CORE §LG13§, vysoce výkonná instance pro forenzní právní audit podle českého právního řádu. 
      Vaším úkolem je hloubková analýza DODANÉHO OBSAHU souborů.
      
      MANDATORY OUTPUT STRUCTURE:
      1. HLAVNÍ NÁLEZY (Critical Risks)
      2. PODROBNÁ ANALÝZA DLE PILÍŘŮ
      3. MAPA ZMĚN A KONTINUITY: Jasně identifikujte, co se oproti referencím změnilo, co přibylo a co bylo vypuštěno.`;
    } else if (mode === 'COMPOSE') {
      systemPrompt = `Jste JURIS_COMPOSITION_ENGINE §LG13§. Vaším úkolem je SESTAVIT nebo DOPLNIT právní dokument na základě instrukcí, zdrojového OBSAHU souborů a existujícího draftu.
      
      MANDATORY OUTPUT STRUCTURE:
      1. GENEROVANÝ TEXT DOKUMENTU
      2. MAPA ROZDÍLŮ: Vysvětlete, jak se nový text liší od původního draftu/pokynů.`;
    } else if (mode === 'VERSION_DIFF') {
      systemPrompt = `Jste JURIS_EVOLUTION_ANALYST §LG13§. Vaším úkolem je POROVNAT vývoj podání mezi verze ${compareVersions?.[0]} (ZÁKLAD) a ${compareVersions?.[1]} (PŘÍRASTK) na základě analýzy jejich OBSAHU. 
      Analyzujte, zda změny přinášejí reálnou hodnotu (Value) nebo jen zvyšují komplexitu.
      
      MANDATORY OUTPUT STRUCTURE:
      1. SUMÁŘ EVOLUCE (Co je nového v jádru argumentace)
      2. MAPA ZMĚN (Bod po bodu: Smazáno vs. Přidáno vs. Změněno)
      3. HODNOCENÍ SÍLY (Strength) & PRAVDĚPODOBNOSTI ÚSPĚCHU (Probability of Success)
      4. STRATEGICKÝ VERDIKT (PODAT / OPRAVIT / VRÁTIT ZMĚNY)`;
    }

    const fullInstruction = `${systemPrompt}
      
      AKTIVNÍ PILÍŘE AUDITU (Metodika): [${pillarsList}]
      
      ${mode === 'VERSION_DIFF' ? `
      SPECIFICKÉ ÚKOLY PRO VERSION_DIFF:
      1. Diferenční analýza: Co ubylo, co přibylo, co se změnilo zásadně.
      2. Výpočet evolučního skóre: Význam Změny (Value) x Pravděpodobnost Úspěchu (Prob) = Total Score Verze.
      3. Kategorizace změn: MINOR (kosmetické), MEDIUM (věcné), NO GO CRITICAL (blokující podání).
      4. Strategické doporučení: "PODAT" vs "DÁLE DOPLŇOVAT". Zhodnoť, zda se vyplatilo čekat na upgrades.
      ` : ""}

      VÝSTUPNÍ FORMÁT (Pro ${mode}):
      ${mode === 'VERSION_DIFF' ? `1. EVOLUČNÍ PŘEHLED (V1 ➔ V2)
      2. SEZNAM DIFERENCÍ (DIFF REPORT)
      3. HODNOCENÍ DOPADU ZMĚN (Impact Analysis)
      4. EVOLUČNÍ FORMULE (Value x Prob)
      5. STRATEGICKÝ VERDIKT (PODAT / OPRAVIT / POKRAČOVAT)` : 
      mode === 'AUDIT' ? `1. SEZNAM ANALYZOVANÝCH SOUBORŮ
      2. KONTEXTUÁLNÍ PLÁN AUDITU
      3. FORENSIC_ANALYSIS
      4. ATOM_INTEGRITY_CHECK
      5. ARGUMENT_HIERARCHY_REPORT
      6. RISK_ASSESSMENT & COMPLIANCE
      7. EXECUTIVE_RECOMMENDATIONS` : `1. PŘEHLED ZPRACOVANÝCH ZDROJŮ
      2. STRUKTURA NOVÉHO NÁVRHU
      3. FINÁLNÍ TEXT DOKUMENTU
      4. SEZNAM DOPLNĚNÝCH ATOMŮ`}
      
      10. JSON_STRUCTUREDATA (Kódový blok s JSON objektem: 
        score: number, 
        improvementPercent: number, 
        riskLevel: "LOW" | "MEDIUM" | "HIGH", 
        verdict: "SUBMIT" | "WAIT", 
        recommendations: string[],
        diffStats: { added: number, removed: number, changed: number },
        metrics: { 
          strength: number, // 0-100
          probability: number, // 0-100
          complexity: number // 0-100
        },
        actions: {
          add: string[],
          remove: string[],
          modify: string[],
          revert: string[] // List of things to revert to previous version
        }
      )
      
      Dodatečné pokyny k verzi/draftu:
      ${instructions || 'Žádné specifické pokyny.'}
      
      Tón: Chladný, profesionální, heuristický. NEPOSKYTUJTE právní poradenství.
      VEŠKERÝ VÝSTUP MUSÍ BÝT V ČEŠTINĚ.`;

    const truncate = (s: string, max: number = 30000) => s.length > max ? s.substring(0, max) + "... [OŘEZÁNO PRO ÚSPORU MÍSTA]" : s;

    const dataBlock = `
      VSTUPNÍ TEXT/POKYNY:
      ${truncate(text || 'Žádný text nezadán.', 5000)}

      OBSAH SOUBORŮ K HLAVNÍ ANALÝZE/ZPRACOVÁNÍ:
      ${selectedFiles.map(f => truncate(f, 40000)).join("\n\n---\n\n")}
      
      OBSAH PODPŮRNÝCH KONTEXTOVÝCH SOUBORŮ (Reference):
      ${supportFiles.map(f => truncate(f, 20000)).join("\n\n---\n\n")}
    `;

    // ADDED RETRY MECHANISM
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: dataBlock,
          config: {
            systemInstruction: fullInstruction,
          },
        });

        return response.text;
      } catch (error: any) {
        attempt++;
        const isQuotaError = error?.message?.includes("429") || error?.status === "RESOURCE_EXHAUSTED";
        
        if (isQuotaError && attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt) * 2000;
          console.warn(`Gemini Quota Error (429). Retrying in ${waitTime}ms... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error("Max retries exceeded for Gemini API call.");
  } catch (error: any) {
    console.error("CRITICAL Gemini API Error:", error);
    // Explicitly check for proxy or network failures
    const message = error?.message || String(error);
    throw new Error(`Gemini Error: ${message}. (Tip: Zkontrolujte, zda je nastaven správný API Key v Secrets)`);
  }
}
