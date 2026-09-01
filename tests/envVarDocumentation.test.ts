import fs from 'fs';
import path from 'path';

describe('Environment variable documentation completeness', () => {
  const configPath = path.join(__dirname, '../src/config.ts');
  const envExamplePath = path.join(__dirname, '../.env.example');

  // Platform-provided vars that don't need documentation
  const PLATFORM_VARS = new Set(['NODE_ENV', 'PORT']);

  interface EnvVarUsage {
    name: string;
    hasDefault: boolean;
    defaultValue?: number | string;
    isNumeric: boolean;
    min?: number;
    max?: number;
    line?: number;
  }

  interface EnvExampleEntry {
    key: string;
    hasComment: boolean;
    comment?: string;
    line?: number;
  }

  let configContent: string;
  let envExampleContent: string;

  beforeAll(() => {
    configContent = fs.readFileSync(configPath, 'utf-8');
    envExampleContent = fs.readFileSync(envExamplePath, 'utf-8');
  });

  /**
   * Extract all environment variable references from config.ts
   */
  function extractEnvVarUsage(): Map<string, EnvVarUsage> {
    const usage = new Map<string, EnvVarUsage>();
    const lines = configContent.split('\n');

    // Pattern to match process.env.VARIABLE or process.env['VARIABLE']
    const envPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    
    // Pattern to match parseNumericEnv calls to extract min/max/default
    const parseNumericPattern = /parseNumericEnv\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*process\.env\.\1\s*,\s*([\d.]+)\s*,\s*(\{[^}]*\})/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match;

      // First, check for parseNumericEnv calls to get detailed info
      const numericMatch = [...line.matchAll(new RegExp(parseNumericPattern.source, 'g'))];
      for (const m of numericMatch) {
        const varName = m[1];
        const defaultValue = parseFloat(m[2]);
        const optionsStr = m[3];
        
        // Parse min/max from options
        let min: number | undefined;
        let max: number | undefined;
        const minMatch = optionsStr.match(/min\s*:\s*([\d.]+)/);
        const maxMatch = optionsStr.match(/max\s*:\s*([\d.]+)/);
        if (minMatch) min = parseFloat(minMatch[1]);
        if (maxMatch) max = parseFloat(maxMatch[1]);

        usage.set(varName, {
          name: varName,
          hasDefault: true,
          defaultValue,
          isNumeric: true,
          min,
          max,
          line: i + 1,
        });
      }

      // Then extract all process.env references
      while ((match = envPattern.exec(line)) !== null) {
        const varName = match[1];
        
        // Skip if we already have detailed info from parseNumericEnv
        if (usage.has(varName)) continue;

        // Check if this line has a default value (simple heuristic)
        const hasDefault = line.includes('??') || line.includes('||');
        let defaultValue: number | string | undefined;
        
        if (hasDefault) {
          // Try to extract the default value
          const defaultMatch = line.match(/\?\?\s*([^,}\n]+)/) || line.match(/\|\|\s*([^,}\n]+)/);
          if (defaultMatch) {
            const defaultStr = defaultMatch[1].trim();
            // Check if it's a number
            const numValue = parseFloat(defaultStr);
            if (!isNaN(numValue) && defaultStr === numValue.toString()) {
              defaultValue = numValue;
            } else if (defaultStr.startsWith("'") || defaultStr.startsWith('"')) {
              defaultValue = defaultStr.slice(1, -1); // Remove quotes
            } else {
              defaultValue = defaultStr;
            }
          }
        }

        usage.set(varName, {
          name: varName,
          hasDefault,
          defaultValue,
          isNumeric: false,
          line: i + 1,
        });
      }
    }

    return usage;
  }

  /**
   * Parse .env.example to extract keys and their comments
   */
  function parseEnvExample(): Map<string, EnvExampleEntry> {
    const entries = new Map<string, EnvExampleEntry>();
    const lines = envExampleContent.split('\n');
    let currentComment: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Accumulate comment lines
      if (line.startsWith('#')) {
        currentComment.push(line.substring(1).trim());
        continue;
      }

      // If we hit a non-comment line, check if it's a KEY=VALUE line
      if (line && !line.startsWith('#')) {
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          if (key) {
            entries.set(key, {
              key,
              hasComment: currentComment.length > 0,
              comment: currentComment.join(' '),
              line: i + 1,
            });
          }
        }
        // Reset comment for next entry
        currentComment = [];
      } else if (!line) {
        // Empty line resets comment
        currentComment = [];
      }
    }

    return entries;
  }

  let configUsage: Map<string, EnvVarUsage>;
  let envExampleEntries: Map<string, EnvExampleEntry>;

  beforeAll(() => {
    configUsage = extractEnvVarUsage();
    envExampleEntries = parseEnvExample();
  });

  it('every env var in config.ts appears in .env.example', () => {
    const missingVars: string[] = [];
    
    for (const [varName, usage] of configUsage) {
      // Skip platform vars
      if (PLATFORM_VARS.has(varName)) continue;
      
      if (!envExampleEntries.has(varName)) {
        missingVars.push(varName);
      }
    }

    if (missingVars.length > 0) {
      const details = missingVars.map(v => {
        const usage = configUsage.get(v)!;
        return `  - ${v} (line ${usage.line})`;
      }).join('\n');
      fail(`Environment variables in config.ts but missing from .env.example:\n${details}`);
    }
  });

  it('every key in .env.example is referenced in config.ts', () => {
    const staleVars: string[] = [];
    
    for (const [key, entry] of envExampleEntries) {
      if (!configUsage.has(key)) {
        staleVars.push(key);
      }
    }

    if (staleVars.length > 0) {
      const details = staleVars.map(v => {
        const entry = envExampleEntries.get(v)!;
        return `  - ${v} (line ${entry.line})`;
      }).join('\n');
      fail(`Environment variables in .env.example but not referenced in config.ts:\n${details}`);
    }
  });

  it('every key in .env.example has a descriptive comment', () => {
    const uncommentedVars: string[] = [];
    
    for (const [key, entry] of envExampleEntries) {
      if (!entry.hasComment) {
        uncommentedVars.push(key);
      }
    }

    if (uncommentedVars.length > 0) {
      const details = uncommentedVars.map(v => {
        const entry = envExampleEntries.get(v)!;
        return `  - ${v} (line ${entry.line})`;
      }).join('\n');
      fail(`Environment variables in .env.example without comments:\n${details}`);
    }
  });

  it('numeric defaults in config.ts satisfy their declared min/max', () => {
    const violations: string[] = [];
    
    for (const [varName, usage] of configUsage) {
      if (!usage.isNumeric || !usage.hasDefault) continue;
      if (usage.min === undefined && usage.max === undefined) continue;
      
      const defaultValue = usage.defaultValue as number;
      
      if (usage.min !== undefined && defaultValue < usage.min) {
        violations.push(
          `${varName}: default ${defaultValue} is below min ${usage.min} (line ${usage.line})`
        );
      }
      
      if (usage.max !== undefined && defaultValue > usage.max) {
        violations.push(
          `${varName}: default ${defaultValue} exceeds max ${usage.max} (line ${usage.line})`
        );
      }
    }

    if (violations.length > 0) {
      fail(`Numeric defaults that violate their min/max constraints:\n${violations.map(v => `  - ${v}`).join('\n')}`);
    }
  });

  it('numeric defaults in .env.example satisfy their documented range', () => {
    const violations: string[] = [];
    
    for (const [key, entry] of envExampleEntries) {
      const usage = configUsage.get(key);
      if (!usage || !usage.isNumeric) continue;
      
      // Extract the default value from .env.example
      const line = envExampleContent.split('\n')[entry.line! - 1];
      const eqIndex = line.indexOf('=');
      if (eqIndex < 0) continue;
      
      const valueStr = line.substring(eqIndex + 1).trim();
      if (!valueStr) continue; // Empty value
      
      const value = parseFloat(valueStr);
      if (isNaN(value)) continue; // Not a numeric value
      
      // Check against min/max from config.ts
      if (usage.min !== undefined && value < usage.min) {
        violations.push(
          `${key}: .env.example value ${value} is below min ${usage.min} (line ${entry.line})`
        );
      }
      
      if (usage.max !== undefined && value > usage.max) {
        violations.push(
          `${key}: .env.example value ${value} exceeds max ${usage.max} (line ${entry.line})`
        );
      }
    }

    if (violations.length > 0) {
      fail(`Numeric values in .env.example that violate their documented range:\n${violations.map(v => `  - ${v}`).join('\n')}`);
    }
  });
});
