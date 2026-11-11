# 道：写 Effect 的原则

为什么这样写。每条一句原则、为什么、落到哪些写法上（[cases.md](.agents/skills/vv-effect/references/cases.md) 的编号）。写法拿不准、两条原则打架、遇到案例里没有的情况时，回到这里判断。入口见 [SKILL.md](.agents/skills/vv-effect/SKILL.md)。

来源：Effect 包自带的 `node_modules/effect/AGENTS.md`；[Effect v4 官方指南](https://effect.website/docs/v4/getting-started)；[Effect Best Practices](https://ethanniser.com/blog/effect-best-practices/)（Ethan Niser）；[Effect Solutions](https://www.effect.solutions/services-and-layers)；[Kit Langton 的 Effect v4 skill](https://www.ui-skills.com/skills/kitlangton/effect)；[TS+ Post-Mortem](https://effect.website/blog/ts-plus-postmortem)（Effect 团队）；[EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns)；[agent doctor](https://effect.doctor/) 的规则分类；2026-11-05 与 2026-11-11 读的。

## 1. 一个 Effect 是一份说明书，不是正在跑的事

原则：写出 `Effect` 只是描述要做什么，运行时才去做；能重试、能超时、能打断、能换掉依赖，都因为它还没跑。

为什么：把它当 Promise（一写就跑、只跑一次）会写出漂着没运行的 Effect、在 `map` 里返回 Effect、在服务里 `runPromise`。

落到：#3、#16、#26；`floatingEffect`、`runEffectInsideEffect` 拦着。

## 2. 失败是值，写进类型

原则：预期的失败是带标签的错误，留在错误通道里；调用方从类型上看得见会怎么失败，按标签分开处理。程序自己的 bug（缺陷）不进错误通道，在边界上统一处理一次。

为什么：`throw` 和 `Error` 让失败在类型里消失，调用方只能猜；把缺陷也当成预期的错误，又会到处 `catch` 掩盖 bug。分清两种，才知道哪个该接、哪个该让它炸。

落到：#6–#11、#37、#39、#42、#43。

## 3. 只接认得的错误，接之前留下记录

原则：按标签接（`catchTag`、`catchTags`、`catchIf`），其余的照样往上走；重试、降级、吞掉之前，先让 span 或日志记下它失败过。

为什么：一下全接住的 `catch` 会把以后新加的失败也悄悄吞掉；恢复以后，trace 里看到的是一次成功，没人知道它失败过几次。

落到：#8、#28、#37。

## 4. 依赖是契约，在入口处接一次

原则：服务先定接口（契约），实现放进 layer；方法签名里不带依赖；整个程序在入口处 provide 一次。

为什么：契约先行，上层的服务能先写、先编过，叶子的实现后补；依赖只在一处接，依赖图清楚，测试换一个 layer 就能换掉实现，不会建出第二份连接池。

落到：#1、#2、#35、#36、#44；`leakingRequirements`、`multipleEffectProvide` 拦着。

## 5. 资源的取得和释放写在一起

原则：打开了要关的东西用 `acquireRelease`，后台任务归作用域；释放由结构保证，不靠「记得关」。

为什么：手写的 `try/finally` 在纤程被打断时不一定跑到；没人管的后台纤程比服务活得久，测试之间互相干扰。

落到：#17、#18、#30。

## 6. 时间、随机和外面的世界都经服务

原则：现在几点经 `Clock`，等待经 `Effect.sleep`，随机、配置、文件、网络、子进程都经服务或 Effect 自己的模块。

为什么：经过服务的东西，测试能换成确定的：`TestClock` 把一分钟拨过去，`ConfigProvider` 换配置，测试不慢也不时好时坏。直接 `Date.now()`、`setTimeout`、`process.env` 的代码测不准。

落到：#21–#24、#26、#48。

## 7. 命名的函数就是 span

原则：返回 Effect 的函数用 `Effect.fn("模块.函数")` 定义；边界上（接口、外面的服务、库的写、队列的交接）有 span，id 这类高基数的值写进注解。

为什么：出问题时先看 trace；没名字的函数在 trace 里是一片空白，看不出是谁、调了几次、慢在哪。名字由结构给出，比事后补日志可靠。

落到：#3、#4、#25、#28。

## 8. 交界收窄，模块要么全用 Effect 要么不用

原则：和 Promise、回调、外面的库打交道只在一次调用上（`tryPromise`、`FiberSet.makeRuntime`），其余都是 Effect；一个模块不写成一半 Promise、一半 Effect。

为什么：混着写的代码，失败、打断、依赖各走两套规则，推理不动；交界只有一处，打断能传过去（`signal`），失败能包成带标签的错误。

落到：#15、#16、#38。

## 9. 不信任的数据在进门处解码

原则：外面来的（请求、文件、库、模型的回答）在进门处用 Schema 解码，里面只收窄过的类型；内部造带约束或品牌的值走 Schema 的 `.make` / `.makeEffect`，不 `as`、不手写守卫（[类型驱动与进门解码](docs/style/module-design.md#类型驱动与进门解码)）。

为什么：`as` 是对编译器说谎，坏数据在很远的地方才炸；在门口解码并让不变量住进类型，错在哪个字段一眼就清楚，里面的代码可以相信类型。

落到：#12–#14、#39、#49。

## 10. 重试只给幂等的操作，策略有上限

原则：用 `Schedule` 写重试、轮询和退避，次数和时长有上限，并发的重试加抖动；只重试做两次也没害处的操作，重试耗尽后失败照样看得见。

为什么：没有上限的退避会把一次故障拖成永远；同一时刻一起重试会把刚恢复的服务再打垮；不幂等的操作重试会做两遍（发两条消息、扣两次钱）。

落到：#21、#22、#31。

## 11. 并发要写上限，共享状态要原子

原则：并发写明 `{ concurrency: n }`，数量由外面定的不用 `"unbounded"`；跨 `yield*` 的「读、算、写」用 `SynchronizedRef`。

为什么：`Effect.all` 默认一个接一个，以为是并行的会慢；没上限的并发会把库和外面的服务打满；`Ref.get` 和 `Ref.set` 之间别的纤程可以插进来。

落到：#19、#20、#32、#33、#41、#45。

## 12. 数据用数据类型，计算用 Effect

原则：`Option`、`Result` 描述一个值（有没有、成不成）；会失败的计算是 Effect。`Option` 用 `Option.isSome` 判断，不当布尔值；判别联合分支和排序等价优先用 `Match`、`Order`、`Equivalence`。

为什么：把会失败的计算写成返回 `Result` 的函数，错误就离开了 Effect 的追踪和组合；`if (option)` 永远为真。

落到：#11、#29、#47、#50。

## 13. 留在标准 TypeScript 里，用检查补足

原则：不发明语法、不改运行时；Effect 的特殊规则靠语言服务（`effect:check`）、lint 和测试守着，agent 默认就写对。

为什么：Effect 团队在 TS+ 上学到的：改语言的代价比带来的整洁大；IDE 和检查能给出同样的提示，又不分裂生态。这个仓库「挡住一类问题先选代码、再选检查、最后才写文字」（`AGENTS.md`）是同一个道理。

落到：#46、[tools.md](.agents/skills/vv-effect/references/tools.md)。

## 14. 一次改一个边界

原则：引入新写法（新的服务、新的错误、新的模块）时，一个边界一个边界地改，每一步都能编过、测过；不一口气重写。

为什么：大面积重写同时动了行为和结构，哪里坏了说不清；一个边界改完、测试证明没变，再改下一个（[vv-governance](.agents/skills/vv-governance/SKILL.md) 的纯重构）。

落到：评审时看一次改动是不是只动了一个边界。

## 15. 看着别扭，先往上看一层

原则：一段代码要靠注释、标志、「设好再还原」、事后复位才说得通时，先问换一个更高一层的结构（库现在给的参数、`Queue`、`Schedule`、一个服务）能不能让这些都不用写；有意这样写的理由查清了，也再问一次。

为什么：别扭的写法常是当时的限制留下的（库还不收参数、还没有对应的模块），限制没了，写法还在；「有原因」只说明它不是错的，不说明它是好的。修一处之前先看它为什么这样，再看站高一层还要不要它。

落到：#40、#41；评审时看一处补丁是不是在绕一个已经不存在的限制。
