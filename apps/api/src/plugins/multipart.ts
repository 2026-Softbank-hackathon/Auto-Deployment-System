/**
 * apps/api/src/plugins/multipart.ts
 * @fastify/multipart 등록. 파일 최대 100MB.
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";

const multipartPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 1,
    },
  });
};

export default fp(multipartPlugin, { name: "multipart" });
