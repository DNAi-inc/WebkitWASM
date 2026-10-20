import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=4096;let instance,visible=false;
const {instance:runtime}=await WebAssembly.instantiate(await readFile(process.argv[2]),{env:{
 root:()=>root,
 collect:()=>{const words=new Uint32Array(instance.exports.memory.buffer);for(let p=instance.exports.__stack_pointer.value;p<65536;p+=4)if(words[p>>>2]===root)visible=true;return 0}
}});
instance=runtime;
assert.equal(instance.exports.run(),root);
console.log(JSON.stringify({operandRootVisible:visible}));
assert.equal(visible,process.argv[3]==='visible');
