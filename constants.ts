
import { Team, Skill, CommandPermission, AIProvider } from './types';

export const INITIAL_TEAMS: Team[] = [
  { id: 'team-personal', name: 'Personal Workspaces', role: 'Admin', memberCount: 1, workspaces: [], tier: 'Starter' },
  { id: 'team-internal', name: 'OpenClaw Internal', role: 'Admin', memberCount: 4, workspaces: [], tier: 'Enterprise' },
];

export const INITIAL_SKILLS: Skill[] = [
  // Core Extensions (Optional)
  { id: 'browser', name: 'Managed Browser', description: 'CDP-gesteuerter Chromium Browser für Snapshots und Interaktionen.', category: 'Web', installed: true, version: '1.0.2' },
  { id: 'search', name: 'Google Search', description: 'Echtzeit-Webzugriff via Google Search Grounding.', category: 'Intelligence', installed: true, version: '3.0.1' },
  
  // Automation & Code
  { id: 'python-runtime', name: 'Python Executor', description: 'Lokale REPL für Data Science, Plotting und Logik.', category: 'Automation', installed: true, version: '3.11.2' },
  { id: 'shell-access', name: 'Safe Shell', description: 'Gekapselter Zugriff auf Bash/ZSH für Systemmanagement.', category: 'Automation', installed: false, version: '2.1.0' },
  { id: 'github-manager', name: 'GitHub Connector', description: 'Repo-Management, Pull Requests und Code-Reviews.', category: 'DevOps', installed: false, version: '1.5.0' },

  // Data & Media
  { id: 'vision', name: 'Live Vision', description: 'Echtzeit-Analyse von Kamera-Feeds und Screen-Streams.', category: 'Media', installed: true, version: '2.4.0' },
  { id: 'sql-bridge', name: 'SQL Bridge', description: 'Sicherer Read/Write Zugriff auf SQL-Datenbanken.', category: 'Data', installed: false, version: '2.0.1' },
  
  // System
  { id: 'vault-sec', name: 'Crypt Vault', description: 'Sichere Verwaltung von API-Keys und Secrets.', category: 'Safety', installed: true, version: '2.0.0' },
  { id: 'filesystem', name: 'File Gateway', description: 'Sandbox-Zugriff auf lokale Dateien und Downloads.', category: 'System', installed: true, version: '0.9.8' },
];

export const SECURITY_RULES: CommandPermission[] = [
  { id: 'c1', command: 'ls', description: 'List directory contents', category: 'Files', risk: 'Low', enabled: true },
  { id: 'c2', command: 'pwd', description: 'Print working directory', category: 'Files', risk: 'Low', enabled: true },
  { id: 'c3', command: 'mkdir', description: 'Create new directories', category: 'Files', risk: 'Medium', enabled: true },
  { id: 'c4', command: 'npm install', description: 'Install package dependencies', category: 'DevOps', risk: 'Medium', enabled: true },
  { id: 'c7', command: 'rm -rf', description: 'Recursive deletion (Danger)', category: 'System', risk: 'High', enabled: false },
  { id: 'c8', command: 'curl', description: 'Transfer data from/to a server', category: 'Network', risk: 'Medium', enabled: true },
];

export const REAL_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-lite-latest',
  'gemini-2.5-flash-latest',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025'
];

export const GEMINI_PROVIDER: AIProvider = { 
  id: 'gemini', 
  name: 'Google Gemini', 
  authType: 'api_key', 
  icon: '✨', 
  availableModels: REAL_MODELS 
};
