
import { memoryStoreSpec, memoryRecallSpec } from './gemini';
import { globalVectorStore } from '../../core/memory/vectorStore';

export default {
  id: 'memory',
  providers: {
    gemini: {
      store: memoryStoreSpec,
      recall: memoryRecallSpec
    }
  },
  execute: async (action: 'store' | 'recall', args: any, currentMemory: any[]) => {
    void currentMemory;
    if (action === 'store') {
      const node = await globalVectorStore.addNode(
        args.type || 'fact',
        String(args.content || ''),
        Number(args.importance || 3),
      );
      return { status: 'stored', entry: node };
    }
    const results = await globalVectorStore.search(String(args.query || ''), Number(args.limit || 5));
    return { status: 'success', results };
  }
};
