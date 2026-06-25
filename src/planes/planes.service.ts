import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan, PlanDocument } from './schemas/plan.schema';

// ── Datos iniciales (seed) ──────────────────────────────────────────────────
// El plan de PRUEBA de 1 Bs NO está aquí; vive solo en el SYSTEM_PROMPT.
const PLANES_INICIALES: Omit<Plan, never>[] = [
  // ── Solo Newsletter ──────────────────────────────────────────────────────
  {
    nombre: 'Solo Newsletter Mensual',
    itemId: 'NL01',
    monto: 19.90,
    frecuencia: 'mensual',
    categoria: 'newsletter',
    descripcion: 'Recibe el boletín diario con las noticias más importantes directamente en tu correo.',
    activo: true,
  },
  {
    nombre: 'Solo Newsletter Trimestral',
    itemId: 'NL03',
    monto: 108,
    frecuencia: 'trimestral',
    categoria: 'newsletter',
    descripcion: 'Boletín diario por 3 meses. Ahorra frente al plan mensual.',
    activo: true,
  },
  {
    nombre: 'Solo Newsletter Anual',
    itemId: 'NL12',
    monto: 192,
    frecuencia: 'anual',
    categoria: 'newsletter',
    descripcion: 'Boletín diario por un año completo. La mejor relación precio-valor para el newsletter.',
    activo: true,
  },

  // ── ePaper + Newsletter ──────────────────────────────────────────────────
  {
    nombre: 'ePaper + Newsletter Mensual',
    itemId: 'epaper01',
    monto: 100,
    frecuencia: 'mensual',
    categoria: 'epaper',
    descripcion: 'Acceso completo al periódico digital (ePaper) más boletín diario en tu correo.',
    activo: true,
  },
  {
    nombre: 'ePaper + Newsletter Trimestral',
    itemId: 'EP03',
    monto: 200,
    frecuencia: 'trimestral',
    categoria: 'epaper',
    descripcion: 'ePaper + newsletter por 3 meses. Ideal para lectores frecuentes.',
    activo: true,
  },
  {
    nombre: 'ePaper + Newsletter Anual',
    itemId: 'epaper12',
    monto: 700,
    frecuencia: 'anual',
    categoria: 'epaper',
    descripcion: 'ePaper + newsletter por un año completo. El plan digital más popular.',
    activo: true,
  },

  // ── Combos digitales ─────────────────────────────────────────────────────
  {
    nombre: 'Combo ePaper 3 Cuentas Anual',
    itemId: 'EP3C12',
    monto: 1100,
    frecuencia: 'anual',
    categoria: 'combo',
    descripcion: 'ePaper + newsletter anual para 3 cuentas. Perfecto para familia o pequeño equipo.',
    activo: true,
  },
  {
    nombre: 'Plan Corporativo 10 Cuentas Anual',
    itemId: 'EPCORP12',
    monto: 2000,
    frecuencia: 'anual',
    categoria: 'combo',
    descripcion: 'ePaper + newsletter anual para hasta 10 cuentas. Ideal para empresas.',
    activo: true,
  },

  // ── Impreso + ePaper + Newsletter ────────────────────────────────────────
  {
    nombre: 'Impreso + ePaper + Newsletter Mensual',
    itemId: 'Impreso1DV',
    monto: 240,
    frecuencia: 'mensual',
    categoria: 'impreso',
    descripcion: 'Periódico físico en domicilio de lunes a domingo + ePaper + newsletter.',
    activo: true,
  },
  {
    nombre: 'Impreso + ePaper + Newsletter Trimestral',
    itemId: 'IMP03',
    monto: 700,
    frecuencia: 'trimestral',
    categoria: 'impreso',
    descripcion: 'Periódico físico + ePaper + newsletter por 3 meses.',
    activo: true,
  },
  {
    nombre: 'Impreso + ePaper + Newsletter Semestral',
    itemId: 'IMP06',
    monto: 1365,
    frecuencia: 'semestral',
    categoria: 'impreso',
    descripcion: 'Periódico físico + ePaper + newsletter por 6 meses.',
    activo: true,
  },
  {
    nombre: 'Impreso Domingo-Viernes + ePaper Anual',
    itemId: 'Impreso1ADV',
    monto: 2700,
    frecuencia: 'anual',
    categoria: 'impreso',
    descripcion: 'Periódico físico de domingo a viernes + ePaper + newsletter durante todo un año.',
    activo: true,
  },
  {
    nombre: 'Impreso Lunes-Viernes + ePaper Anual',
    itemId: 'ImpLV12',
    monto: 2300,
    frecuencia: 'anual',
    categoria: 'impreso',
    descripcion: 'Periódico físico de lunes a viernes + ePaper + newsletter durante todo un año.',
    activo: true,
  },

  // ── Solo Domingo ─────────────────────────────────────────────────────────
  {
    nombre: 'Impreso Solo Domingo Semestral',
    itemId: 'ImpDom06',
    monto: 230,
    frecuencia: 'semestral',
    categoria: 'impreso',
    descripcion: 'Periódico físico solo los domingos en tu domicilio durante 6 meses.',
    activo: true,
  },
  {
    nombre: 'Impreso Solo Domingo Anual',
    itemId: 'ImpDom12',
    monto: 440,
    frecuencia: 'anual',
    categoria: 'impreso',
    descripcion: 'Periódico físico solo los domingos en tu domicilio durante todo un año.',
    activo: true,
  },
];

@Injectable()
export class PlanesService implements OnModuleInit {
  private readonly logger = new Logger(PlanesService.name);

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<PlanDocument>,
  ) {}

  // ── Seed automático al arrancar ──────────────────────────────────────────
  async onModuleInit(): Promise<void> {
    const count = await this.planModel.countDocuments();
    if (count === 0) {
      this.logger.log('Colección "planes" vacía. Insertando planes iniciales...');
      await this.planModel.insertMany(PLANES_INICIALES);
      this.logger.log(`✅ ${PLANES_INICIALES.length} planes insertados en MongoDB.`);
    } else {
      this.logger.log(`ℹ️  Colección "planes" ya tiene ${count} planes. No se requiere seed.`);
    }
  }

  // ── Obtener todos los planes activos ────────────────────────────────────
  async findAll(): Promise<PlanDocument[]> {
    return this.planModel.find({ activo: true }).sort({ categoria: 1, monto: 1 }).exec();
  }

  // ── Resolver plan por nombre (búsqueda flexible) ─────────────────────────
  async resolverPlan(nombre: string): Promise<{ itemId: string; monto: number; frecuencia?: string } | null> {
    const normalized = nombre.toLowerCase().trim();

    // 1. Búsqueda exacta por itemId
    let plan = await this.planModel.findOne({
      activo: true,
      itemId: { $regex: new RegExp(`^${normalized}$`, 'i') },
    });
    if (plan) return { itemId: plan.itemId, monto: plan.monto, frecuencia: plan.frecuencia };

    // 2. Búsqueda por nombre exacto (insensible a mayúsculas)
    plan = await this.planModel.findOne({
      activo: true,
      nombre: { $regex: new RegExp(normalized, 'i') },
    });
    if (plan) return { itemId: plan.itemId, monto: plan.monto, frecuencia: plan.frecuencia };

    // 3. Búsqueda por palabras clave (cada palabra del nombre buscado debe estar en el nombre del plan)
    const palabras = normalized.split(/\s+/).filter((p) => p.length > 2);
    if (palabras.length > 0) {
      const regexes = palabras.map((p) => new RegExp(p, 'i'));
      plan = await this.planModel.findOne({
        activo: true,
        $and: regexes.map((r) => ({ nombre: r })),
      });
      if (plan) return { itemId: plan.itemId, monto: plan.monto, frecuencia: plan.frecuencia };
    }

    this.logger.warn(`No se encontró plan en MongoDB para: "${nombre}"`);
    return null;
  }

  // ── Generar texto del catálogo para el SYSTEM_PROMPT ─────────────────────
  async generarCatalogoPorCategoria(): Promise<string> {
    const planes = await this.findAll();

    const porCategoria: Record<string, PlanDocument[]> = {};
    for (const p of planes) {
      if (!porCategoria[p.categoria]) porCategoria[p.categoria] = [];
      porCategoria[p.categoria].push(p);
    }

    const titulos: Record<string, string> = {
      newsletter: '📧 Solo Newsletter (Boletín diario por correo)',
      epaper:     '📱 ePaper + Newsletter (Periódico digital + boletín)',
      combo:      '🏢 Combos Digitales (Múltiples cuentas)',
      impreso:    '📰 Impreso + ePaper + Newsletter (Físico + digital)',
    };

    let catalogo = '';
    for (const [cat, ps] of Object.entries(porCategoria)) {
      catalogo += `\n### ${titulos[cat] ?? cat}\n`;
      for (const p of ps) {
        catalogo += `- **${p.nombre}:** ${p.monto} Bs — ${p.descripcion}\n`;
      }
    }

    return catalogo.trim();
  }
}
