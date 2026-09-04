import { createJiti } from '/home/oulongwu/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs';

// Mock the ExtensionAPI - just enough to test registration
const mockApi = {
  tools: {},
  registerTool: function(tool) {
    this.tools[tool.name] = tool;
    console.log('Registered tool:', tool.name);
  },
  getAllTools: function() {
    return Object.values(this.tools);
  }
};

async function test() {
  console.log('Starting lazy load test...');
  const startTime = Date.now();
  
  const jiti = createJiti(import.meta.url);
  const fabricPath = '/home/oulongwu/.pi/agent/npm/node_modules/pi-fabric/dist/index.js';
  
  console.log('Loading pi-fabric from:', fabricPath);
  try {
    const fabricFactory = await jiti.import(fabricPath);
    console.log('pi-fabric factory loaded');
    
    await fabricFactory(mockApi);
    console.log('pi-fabric factory executed');
    
    const tools = mockApi.getAllTools();
    console.log('Tools registered:', tools.map(t => t.name));
    
    const fabricExec = tools.find(t => t.name === 'fabric_exec');
    if (fabricExec) {
      console.log('fabric_exec found!');
      console.log('Trying to execute fabric_exec...');
      try {
        const result = await fabricExec.handler({ code: 'return "hello"' });
        console.log('fabric_exec execution result:', result);
      } catch (e) {
        console.error('fabric_exec execution failed:', e.message);
        console.error('Stack:', e.stack?.split('\n').slice(0, 10).join('\n'));
      }
    } else {
      console.log('fabric_exec NOT found');
    }
    
  } catch (e) {
    console.error('Failed to load pi-fabric:', e.message);
    console.error('Stack:', e.stack?.split('\n').slice(0, 20).join('\n'));
  }
  
  console.log('Total time:', Date.now() - startTime, 'ms');
}

test();
