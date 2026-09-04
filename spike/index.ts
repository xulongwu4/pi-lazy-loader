import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const resultsPath = join(dirname(fileURLToPath(import.meta.url)), 'results.txt');

export default async function spikeExtension(api) {
  api.registerTool({
    name: 'spike_load_fabric',
    description: 'Spike: dynamically load pi-fabric and test if it works',
    handler: async (args) => {
      const startTime = Date.now();
      
      try {
        // Load pi-fabric via jiti
        const { createJiti } = await import('jiti');
        const jiti = createJiti(import.meta.url);
        
        const fabricPath = '/home/oulongwu/.pi/agent/npm/node_modules/pi-fabric/dist/index.js';
        
        const fabricFactory = await jiti.import(fabricPath);
        await fabricFactory(api);
        
        // Check what tools exist after loading
        const toolsAfter = api.getAllTools().map(t => t.name);
        const hasFabricAfter = toolsAfter.includes('fabric_exec');
        const newTools = toolsAfter.filter(t => t.name.startsWith('fabric') || t.name === 'fabric_exec');
        
        // Try to actually call fabric_exec if it registered
        let execResult = 'SKIPPED';
        if (hasFabricAfter) {
          try {
            const fabricExecTool = api.getAllTools().find(t => t.name === 'fabric_exec');
            if (fabricExecTool) {
              await fabricExecTool.handler({ code: 'return "hello from fabric_exec"' });
              execResult = 'SUCCESS';
            }
          } catch (e) {
            execResult = `FAILED: ${e.message}\n${e.stack?.split('\n').slice(0, 10).join('\n')}`;
          }
        }
        
        const results = `SPIKE RESULTS:\nLoad time: ${Date.now() - startTime}ms\nLoad result: SUCCESS\nfabric_exec after: ${hasFabricAfter}\nNew fabric tools: ${newTools.join(', ')}\nfabric_exec execution: ${execResult}\n`;
        await writeFile(resultsPath, results, 'utf-8');
        return results;
        
      } catch (e) {
        const results = `SPIKE RESULTS:\nLoad time: ${Date.now() - startTime}ms\nLoad result: FAILED\nError: ${e.message}\nStack: ${e.stack?.split('\n').slice(0, 20).join('\n')}\n`;
        await writeFile(resultsPath, results, 'utf-8');
        return results;
      }
    }
  });
};
