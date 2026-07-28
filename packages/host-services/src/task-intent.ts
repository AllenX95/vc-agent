export function detectMaterialRecallIntent(text: string): boolean {
  const chineseSource = /(项目|当前|已有|上传|附件|文件夹).{0,12}(材料|文件|文档|BP|商业计划书|团队介绍|技术成果|路演稿)|(材料|文件|文档|BP|商业计划书|团队介绍|技术成果|路演稿).{0,12}(分析|阅读|查看|总结|提取|基于|根据)/iu.test(text);
  const englishSource = /\b(project|current|attached|uploaded|supplied)\b.{0,30}\b(materials?|files?|documents?|deck|business plan|team profile|technical results?)\b|\b(read|review|analy[sz]e|summari[sz]e|extract from|based on)\b.{0,30}\b(materials?|files?|documents?|deck|business plan)\b/iu.test(text);
  return chineseSource || englishSource;
}

export function detectProjectStateRecallIntent(text: string): boolean {
  const chinese = /(项目背景|项目状态|当前进展|工作状态|项目上下文|项目 context|context 面板|上下文面板)|(使用|读取|查看|召回|参考).{0,12}(context|上下文)/iu.test(text);
  const english = /\b(project context|project status|current project state|working state|context panel)\b|\b(use|read|recall|consult)\b.{0,20}\bcontext\b/iu.test(text);
  return chinese || english;
}
