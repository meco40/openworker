
import { CORE_MEMORY_TOOLS } from './gemini';
import { globalVectorStore } from './vectorStore';

export { CORE_MEMORY_TOOLS };

export const handleCoreMemoryCall = async (fcName: string, args: any) => {
  if (fcName === 'core_memory_store') {
    const node = await globalVectorStore.addNode(args.type, args.content, args.importance || 3);
    return { action: 'store', data: node };
  }
  
  if (fcName === 'core_memory_recall') {
    const results = await globalVectorStore.search(args.query, args.limit || 3);
    // Wir geben nur den relevanten Content zurück, um Token zu sparen
    const context = results
      .filter(r => r.similarity > 0.7) // Nur hochrelevante Treffer
      .map(r => `[Type: ${r.node.type}] ${r.node.content}`)
      .join('\n');
      
    return { action: 'recall', data: context || "No relevant memories found." };
  }
  
  return null;
};

export const getMemorySnapshot = () => globalVectorStore.getAllNodes();
