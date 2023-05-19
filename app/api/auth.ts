import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX } from "../constant";

const serverConfig = getServerSideConfig();

function getIP(req: NextRequest) {
  let ip = req.ip ?? req.headers.get("x-real-ip");
  const forwardedFor = req.headers.get("x-forwarded-for");

  if (!ip && forwardedFor) {
    ip = forwardedFor.split(",").at(0) ?? "";
  }

  return ip;
}

function parseApiKey(bearToken: string) {
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();
  const isOpenAiKey = !token.startsWith(ACCESS_CODE_PREFIX);

  return {
    accessCode: isOpenAiKey ? "" : token.slice(ACCESS_CODE_PREFIX.length),
    apiKey: isOpenAiKey ? token : "",
  };
}

export function auth(req: NextRequest) {
  const authToken = req.headers.get("Authorization") ?? "";

  // check if it is openai api key or user token
  const { accessCode, apiKey: token } = parseApiKey(authToken);

  const hashedCode = md5.hash(accessCode ?? "").trim();

  console.log("[Auth] allowed hashed codes: ", [...serverConfig.codes]);
  console.log("[Auth] got access code:", accessCode);
  console.log("[Auth] hashed access code:", hashedCode);
  console.log("[User IP] ", getIP(req));
  console.log("[Time] ", new Date().toLocaleString());

  // if (serverConfig.needCode && !serverConfig.codes.has(hashedCode) && !token) {
  //   return {
  //     error: true,
  //     msg: !accessCode ? "empty access code" : "wrong access code",
  //   };
  // }
  if (serverConfig.needCode && !token) {
    //check accessCode
    if (!accessCode) {
      return {
        error: true,
        msg: "请输入访问密码",
      };
    }
    //校验权限
    const tokenCheckUrl =
      "http://chat-gpt.7miyu.com/api/common/chat/token/info";
    let chatCheckHeader: Record<string, string> = {
      "Content-Type": "application/json",
      chatToken: accessCode,
    };
    const tokenVertfyPayload = {
      method: "GET",
      headers: chatCheckHeader,
    };
    const checkResult = fetch(tokenCheckUrl, tokenVertfyPayload).then(
      (response) => {
        console.log(response);
        console.log("[Token Check]: ", response);
        // var res=response.json();
        // if(res.code!=200){
        //   return {
        //     error: true,
        //     msg: "访问密码信息已失效，请重新填写访问密码",
        //   };
        // }
      },
    );
  }

  // if user does not provide an api key, inject system api key
  if (!token) {
    const apiKey = serverConfig.apiKey;
    if (apiKey) {
      console.log("[Auth] use system api key");
      req.headers.set("Authorization", `Bearer ${apiKey}`);
    } else {
      console.log("[Auth] admin did not provide an api key");
      return {
        error: true,
        msg: "admin did not provide an api key",
      };
    }
  } else {
    console.log("[Auth] use user api key");
  }

  return {
    error: false,
  };
}
