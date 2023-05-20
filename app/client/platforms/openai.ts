import { REQUEST_TIMEOUT_MS } from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

import { ChatOptions, getHeaders, LLMApi, LLMUsage } from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@microsoft/fetch-event-source";
import { prettyObject } from "@/app/utils/format";

export class ChatGPTApi implements LLMApi {
  public ChatPath = "v1/chat/completions";
  public UsagePath = "dashboard/billing/usage";
  public SubsPath = "dashboard/billing/subscription";

  path(path: string): string {
    let openaiUrl = useAccessStore.getState().openaiUrl;
    if (openaiUrl.endsWith("/")) {
      openaiUrl = openaiUrl.slice(0, openaiUrl.length - 1);
    }
    return [openaiUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async chat(options: ChatOptions) {
    const accessStore = useAccessStore.getState();
    const accessCode = accessStore.accessCode;
    console.log("[chat]发起chat", accessStore);
    //check accessCode
    if (!accessCode) {
      options.onFinish(
        "请输入访问密码，获取方式说明：https://www.7miyu.com/#/articles/64",
      );
      return;
    }
    //校验权限
    const tokenCheckUrl = "/blogservice/common/chat/token/info";
    let chatCheckHeader: Record<string, string> = {
      "Content-Type": "application/json",
      chatToken: accessCode,
    };
    const tokenVertfyPayload = {
      method: "GET",
      headers: chatCheckHeader,
    };
    const checkResult = await fetch(tokenCheckUrl, tokenVertfyPayload);
    const checkResultJson = await checkResult.json();
    console.log("[Token Check]: ", checkResultJson);
    if (checkResultJson.code != 20000) {
      options.onFinish(
        "您的访问秘钥已过期，请重新获取。获取方式说明：https://www.7miyu.com/#/articles/64",
      );
      return;
    }

    const messages = options.messages.map((v) => ({
      role: v.role,
      content: v.content,
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const requestPayload = {
      messages,
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
    };

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(this.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        let responseText = "";

        const finish = () => {
          options.onFinish(responseText);
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            if (
              res.ok &&
              res.headers.get("content-type") !== EventStreamContentType
            ) {
              responseText += await res.clone().json();
              return finish();
            }
            if (res.status === 401) {
              let extraInfo = { error: undefined };
              try {
                extraInfo = await res.clone().json();
              } catch {}

              responseText += "\n\n" + Locale.Error.Unauthorized;

              if (extraInfo.error) {
                responseText += "\n\n" + prettyObject(extraInfo);
              }

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]") {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text);
              const delta = json.choices[0].delta.content;
              if (delta) {
                responseText += delta;
                options.onUpdate?.(responseText, delta);
              }
            } catch (e) {
              console.error("[Request] parse error", text, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat reqeust", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${this.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(this.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (!used.ok || !subs.ok || used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }
}
