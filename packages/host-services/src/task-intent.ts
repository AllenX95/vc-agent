export function detectMaterialRecallIntent(text: string): boolean {
  const explicitFileMention = /(?:^|\s)@(?:"(?:[^"\\]|\\.)+"|[^\s@]+)/u.test(text);
  const chineseSource = /(项目|当前|已有|上传|附件|文件夹).{0,12}(材料|文件|文档|BP|商业计划书|团队介绍|技术成果|路演稿)|(材料|文件|文档|BP|商业计划书|团队介绍|技术成果|路演稿).{0,12}(分析|阅读|查看|总结|提取|基于|根据)|(分析|阅读|查看|总结|提取|评估|基于|根据).{0,20}(材料|文件|文档|PDF|BP|商业计划书|团队介绍|技术成果|路演稿)/iu.test(text);
  const englishSource = /\b(project|current|attached|uploaded|supplied)\b.{0,30}\b(materials?|files?|documents?|deck|business plan|team profile|technical results?)\b|\b(read|review|analy[sz]e|summari[sz]e|extract from|based on)\b.{0,30}\b(materials?|files?|documents?|deck|business plan)\b/iu.test(text);
  return explicitFileMention || chineseSource || englishSource;
}

export function detectWebResearchIntent(text: string): boolean {
  const url = /https?:\/\/\S+/iu.test(text);
  const english = /\b(search|browse|look up|latest|current|news|public web|online research|web research)\b/iu.test(text);
  const chinese = /(搜索|上网查|联网查|查找最新|最新新闻|网页|公开网络|网络调研|实时资料)/u.test(text);
  return url || english || chinese;
}

export function detectProjectStateRecallIntent(text: string): boolean {
  const chinese = /(项目背景|项目状态|当前进展|工作状态|项目上下文|项目 context|context 面板|上下文面板)|(使用|读取|查看|召回|参考).{0,12}(context|上下文)/iu.test(text);
  const english = /\b(project context|project status|current project state|working state|context panel)\b|\b(use|read|recall|consult)\b.{0,20}\bcontext\b/iu.test(text);
  return chinese || english;
}

export function detectTextEditIntent(text: string): boolean {
  const chinese = /(修改|编辑|修订|更新|替换|改写).{0,16}(输出|文件|文档|报告|备忘录|文本|markdown|memo)/iu.test(text);
  const english = /\b(edit|modify|revise|update|replace|rewrite)\b.{0,30}\b(output|file|document|report|memo|text|markdown)\b/iu.test(text);
  return chinese || english;
}

export function detectFileDownloadIntent(text: string): boolean {
  const chinese = /(下载|保存|存到|落盘|归档).{0,40}(PDF|文件|文档|附件|本地|磁盘|文件夹|目录|当前|项目|arxiv|论文|全文)/iu.test(text);
  const english = /\b(download|save|store|archive|retain)\b.{0,60}\b(file|pdf|document|attachment|locally|disk|folder|directory|arxiv|paper|full[- ]?text)\b/iu.test(text);
  return chinese || english;
}

export function detectArxivFulltextIntent(text: string): boolean {
  const acquisition = /(下载|保存|存到|落盘|归档|保留|download|save|store|archive|retain)/iu.test(text);
  const arxiv = /(?:arxiv(?:\.org)?|arxiv\s*(?:论文|paper|全文|full[- ]?text))/iu.test(text);
  return acquisition && arxiv;
}

export function detectAcademicResearchIntent(text: string): boolean {
  const chinese = /(论文|学术|arxiv|openalex|引用|被引|作者|研究者|前序工作|相关工作|原创性|sota|开源代码|模型权重|hugging\s*face|github|技术宣称|论文到公司)/iu.test(text);
  const english = /\b(paper|academic|arxiv|openalex|citation|cited by|author|researcher|prior work|related work|novelty|sota|open[- ]source|model weights?|hugging\s*face|github|technical claim|research[- ]to[- ]company)\b/iu.test(text);
  return chinese || english;
}
