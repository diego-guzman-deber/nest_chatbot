import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Necesario para verificar la firma X-Hub-Signature-256 de Meta
  // Guarda el raw body en req['rawBody'] antes de parsear JSON
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req['rawBody'] = buf;
      },
    }),
  );

  const port = process.env.PORT ?? 8000;
  await app.listen(port);
  Logger.log(`🚀 WhatsApp Bot corriendo en puerto ${port}`, 'Bootstrap');

  // ── Verificación de variables de entorno críticas al arranque ──────────────
  const requiredEnvs = ['PHONE_NUMBER_ID', 'ACCESS_TOKEN', 'APP_SECRET', 'VERIFY_TOKEN'];
  const missing = requiredEnvs.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    Logger.error(`⚠️  Variables de entorno faltantes: ${missing.join(', ')}`, 'Bootstrap');
  } else {
    Logger.log('✅ Todas las variables de entorno críticas están presentes', 'Bootstrap');
    Logger.log(`   PHONE_NUMBER_ID: ${process.env.PHONE_NUMBER_ID}`, 'Bootstrap');
    Logger.log(`   ACCESS_TOKEN: ${process.env.ACCESS_TOKEN?.slice(0, 10)}...`, 'Bootstrap');
  }
}
bootstrap();
