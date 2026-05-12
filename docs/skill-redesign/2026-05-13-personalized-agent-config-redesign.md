# personalized-agent-config SKILL.md 顶层重构方案

## 范围

- 只做顶层结构设计。
- 不改任何 skill / reference 文件。
- critique 对象是你提供的“当前 SKILL.md”文本。

## 1) @oracle 结构化 critique

### 总体判断

素材对，但仍像事实清单；应改写成“任务形态→运行时机制→成本后果”的推理文。

### 主要问题

- 事实多因果少，可删约三成。
- `orchestrator`/`build` 差异没升成主轴：前者会内部分派 specialist、可跨模型；后者单模型。
- “How To Reason”仍是规则 bullet；且没先拆开 runtime 与 model 两维。
- runtime/model/references 重叠，CLI 分散，还默认读者已懂 lead/subagent。

### 保留项

- 机器/quota live readout：保留。
- runtime 描述、模型表、Non-Negotiables：保留，但降为机制后的二级信息。

### 新骨架

1. Purpose — 本机 cheapest competent routing。
2. Live Inputs — 机器、quota、self、role→model。
3. Mental Model — runtime ≠ model。
4. Runtime Mechanics — Claude/OpenCode/Paseo/Daytona。
5. Fan-out & Cost — orchestrator 混合，build 单模型。
6. Decision Table — 任务形态→路由。
7. Engine Heuristics — 粗档位+tiebreak。
8. Safety + References — guardrails 留正文，深表下放。

## 2) @council 多模型 review

### Council Response

先讲运行时，再讲模型：先选车辆，再选引擎。SKILL.md 只留心智模型、运行时语义、fan-out、粗档位、默认回退、成本粗档；完整模型表/定价/上下文窗/供应商细节下放 references。

### Councillor Details

- **alpha（glm-5.1）**：fan-out 并入 Runtime Mechanics；“路由流程”改决策表；必须补“失败/回退/降级”。
- **beta（gpt-5.5）**：同意运行时先行；`Engine Selection` 名称更好；可加 `Routing Presets`。
- **共识**：最大缺口是回退机制，不是模型细节。

### Council Summary

一致：运行时先行、fan-out 合并、补降级回退章节；分歧只在命名与是否加预设表。

## 3) 建议落地版本骨架

Purpose（4-5）目标；Live（8-10）机器+quota+self；Mental（8-10）runtime≠model；Mechanics（14-18）含 fan-out/单模型；Decision（10-12）任务形态→路由；Engine（8-10）粗档位+tiebreak；Fallbacks（6-8）回退；CLI（4-6）真命令；Refs（3-4）深表下放。
