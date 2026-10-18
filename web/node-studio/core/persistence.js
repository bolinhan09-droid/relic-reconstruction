import {copy, assertWorkflow} from './model.js';
/* One serialized writer per window. A conflict never overwrites another window. */
export class WorkflowPersistence {
  constructor(api,onState) {this.api=api;this.onState=onState;this.queue=Promise.resolve();this.timer=null;this.generation=0;this.savedGeneration=0;this.revision=0;}
  bind(workflow) {clearTimeout(this.timer);this.revision=workflow.revision;this.generation=0;this.savedGeneration=0;}
  changed(getWorkflow,onSaved) {this.generation++;this.onState('尚未保存');clearTimeout(this.timer);this.timer=setTimeout(()=>this.save(getWorkflow,onSaved).catch(()=>{}),850);}
  async save(getWorkflow,onSaved) {
    clearTimeout(this.timer);
    const job=async()=>{
      const workflow=getWorkflow();if(!workflow)return;
      const generation=this.generation,snapshot=copy(workflow);assertWorkflow(snapshot);this.onState('正在保存…');
      try {
        const result=await this.api('PUT',`/api/node-studio/workflows/${encodeURIComponent(snapshot.id)}`,{workflow:snapshot,expectedRevision:this.revision});
        const saved=result.workflow||result;this.revision=saved.revision;this.savedGeneration=generation;
        onSaved(saved,generation===this.generation);this.onState(generation===this.generation?'已保存到本机':'尚未保存');return saved;
      } catch(error) {this.onState(error.status===409?'其他窗口已更新，请重新打开':'保存未完成');throw error;}
    };
    this.queue=this.queue.catch(()=>{}).then(job);return this.queue;
  }
}
