import BetterSqlite3 from 'better-sqlite3';

const messagesDb = new BetterSqlite3('.local/messages.db', { readonly: true });

// 1. Check FTS5 for "Regeln" 
console.log('=== FTS5 Search for "Regeln" ===');
try {
  const ftsResults = messagesDb.prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
    FROM messages m
    JOIN messages_fts fts ON fts.rowid = m.rowid
    WHERE messages_fts MATCH ?
    ORDER BY bm25(messages_fts) ASC
    LIMIT 10
  `).all('Regeln') as Array<{ id: string; conversation_id: string; role: string; content: string; created_at: string }>;
  
  console.log(`Found ${ftsResults.length} FTS results`);
  for (const r of ftsResults) {
    console.log(`  [${r.role}] conv:${r.conversation_id.substring(0, 8)} | ${r.content.substring(0, 100)}`);
  }
} catch (e) {
  console.log('FTS error:', e);
}

// 2. Check knowledge tables
console.log('\n=== Knowledge Episodes ===');
const episodes = messagesDb.prepare('SELECT * FROM knowledge_episodes LIMIT 5').all() as Array<Record<string, unknown>>;
console.log(`Total episodes: ${(messagesDb.prepare('SELECT COUNT(*) as cnt FROM knowledge_episodes').get() as { cnt: number }).cnt}`);
for (const ep of episodes) {
  console.log(`  ${(ep.topic_key as string)} | ${(ep.teaser as string).substring(0, 80)}`);
}

// 3. Check memory_nodes
console.log('\n=== Memory Nodes ===');
const memNodes = messagesDb.prepare("SELECT * FROM memory_nodes WHERE content LIKE '%Regeln%' OR content LIKE '%regel%'").all() as Array<Record<string, unknown>>;
console.log(`Memory nodes matching 'Regeln': ${memNodes.length}`);
for (const n of memNodes) {
  console.log(`  [${n.memory_type}] ${(n.content as string).substring(0, 120)}`);
}

// 4. Check all messages with "Merken" or "Regeln" keyword
console.log('\n=== Messages with "Merken" or "Regeln" ===');
const merkenMsgs = messagesDb.prepare(`
  SELECT id, conversation_id, role, content, created_at 
  FROM messages 
  WHERE content LIKE '%Merken%' OR content LIKE '%merken%' OR (content LIKE '%Regel%' AND content LIKE '%1.%' AND content LIKE '%2.%')
  LIMIT 10
`).all() as Array<{ id: string; conversation_id: string; role: string; content: string; created_at: string }>;
console.log(`Found ${merkenMsgs.length} messages`);
for (const m of merkenMsgs) {
  console.log(`  [${m.role}] conv:${m.conversation_id.substring(0, 8)} | ${m.content.substring(0, 150)}`);
}

// 5. Total messages count
const totalMsgs = messagesDb.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
console.log(`\nTotal messages in DB: ${totalMsgs.cnt}`);

messagesDb.close();

// 6. Check Mem0 for rules
console.log('\n=== Mem0 Search for "Regeln" ===');
try {
  const resp = await fetch('http://127.0.0.1:8000/v1/memories/search/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'Wie sind die Regeln auf der Arbeit',
      user_id: 'legacy-local-user',
      agent_id: 'e3f273b8-bf9e-4293-97ed-d6bc34d293ff',
      limit: 10
    })
  });
  const data = await resp.json() as { results?: Array<{ memory: string; score: number }> };
  console.log(`Found ${data.results?.length ?? 0} mem0 results`);
  for (const r of data.results ?? []) {
    console.log(`  [score:${r.score.toFixed(3)}] ${r.memory.substring(0, 120)}`);
  }
} catch (e) {
  console.log('Mem0 error:', e);
}
