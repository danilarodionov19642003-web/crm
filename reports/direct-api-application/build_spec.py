from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT.parent.parent / "output" / "pdf"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUTPUT_DIR / "Спецификация_MENTORI_Direct_MCP.pdf"

FONT_REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
pdfmetrics.registerFont(TTFont("Arial", FONT_REGULAR))
pdfmetrics.registerFont(TTFont("Arial-Bold", FONT_BOLD))

PAGE_W, PAGE_H = A4
MARGIN_X = 18 * mm
MARGIN_TOP = 18 * mm
MARGIN_BOTTOM = 16 * mm

INK = colors.HexColor("#12141A")
MUTED = colors.HexColor("#626873")
SOFT = colors.HexColor("#F3F4F6")
LINE = colors.HexColor("#DADDE3")
RED = colors.HexColor("#D7252A")
RED_DARK = colors.HexColor("#A91419")
WHITE = colors.white


class Architecture(Flowable):
    def __init__(self, width):
        super().__init__()
        self.width = width
        self.height = 52 * mm

    def draw(self):
        c = self.canv
        box_w = (self.width - 20 * mm) / 3
        box_h = 23 * mm
        y = 19 * mm
        boxes = [
            (0, "Codex Desktop", "Интерфейс оператора"),
            (box_w + 10 * mm, "MENTORI MCP", "Локальный сервер"),
            (2 * (box_w + 10 * mm), "Яндекс Директ", "API v5 / JSON"),
        ]
        for idx, (x, title, sub) in enumerate(boxes):
            c.setFillColor(INK if idx != 1 else RED)
            c.roundRect(x, y, box_w, box_h, 3 * mm, fill=1, stroke=0)
            c.setFillColor(WHITE)
            c.setFont("Arial-Bold", 10)
            c.drawCentredString(x + box_w / 2, y + 13.5 * mm, title)
            c.setFont("Arial", 7.8)
            c.drawCentredString(x + box_w / 2, y + 7.8 * mm, sub)
            if idx < 2:
                x1 = x + box_w + 1.5 * mm
                x2 = x + box_w + 8.5 * mm
                cy = y + box_h / 2
                c.setStrokeColor(RED)
                c.setLineWidth(1.6)
                c.line(x1, cy, x2, cy)
                c.line(x2 - 2.2 * mm, cy + 1.6 * mm, x2, cy)
                c.line(x2 - 2.2 * mm, cy - 1.6 * mm, x2, cy)

        c.setFillColor(MUTED)
        c.setFont("Arial", 7.5)
        c.drawCentredString(
            self.width / 2,
            8 * mm,
            "Авторизация пользователя через Яндекс OAuth. Токен хранится только локально.",
        )


class MockPanel(Flowable):
    def __init__(self, width):
        super().__init__()
        self.width = width
        self.height = 57 * mm

    def draw(self):
        c = self.canv
        c.setFillColor(INK)
        c.roundRect(0, 0, self.width, self.height, 4 * mm, fill=1, stroke=0)
        c.setFillColor(colors.HexColor("#2A2D35"))
        c.roundRect(7 * mm, 8 * mm, self.width - 14 * mm, self.height - 16 * mm, 3 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Arial-Bold", 10)
        c.drawString(13 * mm, self.height - 17 * mm, "Проверить результаты кампаний за период")
        c.setFont("Arial", 8.2)
        c.setFillColor(colors.HexColor("#C8CBD2"))
        c.drawString(13 * mm, self.height - 24 * mm, "Оператор задаёт запрос в Codex, MCP получает данные из API.")

        labels = [("Показы", "3 479"), ("Клики", "387"), ("Расход", "5 537,63 руб."), ("Цели", "12")]
        cell_w = (self.width - 26 * mm) / 4
        for i, (label, value) in enumerate(labels):
            x = 13 * mm + i * cell_w
            c.setFillColor(RED if i == 3 else WHITE)
            c.setFont("Arial-Bold", 10)
            c.drawString(x, self.height - 36 * mm, value)
            c.setFillColor(colors.HexColor("#969BA6"))
            c.setFont("Arial", 7.4)
            c.drawString(x, self.height - 42 * mm, label)


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(INK)
    canvas.rect(0, PAGE_H - 12 * mm, PAGE_W, 12 * mm, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Arial-Bold", 9)
    canvas.drawString(MARGIN_X, PAGE_H - 7.8 * mm, "MENTORI")
    canvas.setFillColor(RED)
    canvas.circle(MARGIN_X - 4 * mm, PAGE_H - 6.3 * mm, 1.1 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#AEB2BA"))
    canvas.setFont("Arial", 7.5)
    canvas.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 7.8 * mm, "Внутреннее приложение для Яндекс Директ API")

    canvas.setStrokeColor(LINE)
    canvas.line(MARGIN_X, 10.5 * mm, PAGE_W - MARGIN_X, 10.5 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Arial", 7.5)
    canvas.drawString(MARGIN_X, 6.5 * mm, "mentori.tech")
    canvas.drawRightString(PAGE_W - MARGIN_X, 6.5 * mm, f"Страница {doc.page}")
    canvas.restoreState()


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="TitleRu",
        fontName="Arial-Bold",
        fontSize=24,
        leading=27,
        textColor=INK,
        spaceAfter=5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="LeadRu",
        fontName="Arial",
        fontSize=10.5,
        leading=15,
        textColor=MUTED,
        spaceAfter=5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="H2Ru",
        fontName="Arial-Bold",
        fontSize=14,
        leading=17,
        textColor=INK,
        spaceBefore=3 * mm,
        spaceAfter=2.5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyRu",
        fontName="Arial",
        fontSize=9.2,
        leading=13.2,
        textColor=INK,
        spaceAfter=2.2 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="BulletRu",
        fontName="Arial",
        fontSize=9,
        leading=12.5,
        textColor=INK,
        leftIndent=5 * mm,
        firstLineIndent=-3.5 * mm,
        bulletIndent=0,
        spaceAfter=1.3 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="SmallRu",
        fontName="Arial",
        fontSize=7.8,
        leading=10.5,
        textColor=MUTED,
    )
)
styles.add(
    ParagraphStyle(
        name="TagRu",
        fontName="Arial-Bold",
        fontSize=7.8,
        leading=10,
        textColor=WHITE,
        alignment=TA_CENTER,
    )
)


def bullet(text):
    return Paragraph(f"<bullet color='#D7252A'>•</bullet>{text}", styles["BulletRu"])


def info_table(rows):
    data = [[Paragraph(k, styles["SmallRu"]), Paragraph(v, styles["BodyRu"])] for k, v in rows]
    table = Table(data, colWidths=[42 * mm, 128 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SOFT),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
            ]
        )
    )
    return table


doc = BaseDocTemplate(
    str(OUTPUT),
    pagesize=A4,
    leftMargin=MARGIN_X,
    rightMargin=MARGIN_X,
    topMargin=MARGIN_TOP,
    bottomMargin=MARGIN_BOTTOM,
    title="Спецификация MENTORI Direct MCP",
    author="MENTORI",
    subject="Заявка на доступ к Яндекс Директ API",
)
frame = Frame(
    MARGIN_X,
    MARGIN_BOTTOM,
    PAGE_W - 2 * MARGIN_X,
    PAGE_H - MARGIN_TOP - MARGIN_BOTTOM,
    leftPadding=0,
    rightPadding=0,
    topPadding=0,
    bottomPadding=0,
)
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=header_footer)])

story = []
story.append(Spacer(1, 5 * mm))
story.append(Paragraph("Спецификация MENTORI Direct MCP", styles["TitleRu"]))
story.append(
    Paragraph(
        "Разрабатываемое внутреннее локальное приложение для безопасной работы сотрудников MENTORI с рекламными кабинетами клиентов через официальный API Яндекс Директа.",
        styles["LeadRu"],
    )
)
story.append(
    info_table(
        [
            ("Разработчик", "MENTORI"),
            ("Сайт", "https://mentori.tech"),
            ("Тип приложения", "Разрабатываемый внутренний локальный MCP-коннектор"),
            ("Технологии", "Python 3.12, HTTPS, JSON, Яндекс Директ API v5"),
            ("Пример логина в Директе", "spektrmetalla@mail.ru"),
            ("Дата спецификации", "5 августа 2026 года"),
        ]
    )
)
story.append(Paragraph("Назначение", styles["H2Ru"]))
story.append(
    Paragraph(
        "Приложение сокращает ручную работу при анализе и сопровождении рекламных кампаний. Оно получает данные только после OAuth-авторизации пользователя, показывает статистику в интерфейсе Codex и выполняет изменения только после явного подтверждения оператора.",
        styles["BodyRu"],
    )
)
story.extend(
    [
        bullet("Получение статистики, отчётов, поисковых запросов и параметров кампаний."),
        bullet("Управление кампаниями, группами, объявлениями, ключевыми и минус-фразами."),
        bullet("Контроль расписания, географии, ставок, стратегий и бюджетных ограничений."),
        bullet("Подготовка предпросмотра изменений до отправки команды в API."),
        bullet("Формирование клиентских отчётов на основе фактических данных кабинета."),
    ]
)
story.append(Paragraph("Планируемая схема взаимодействия", styles["H2Ru"]))
story.append(Architecture(PAGE_W - 2 * MARGIN_X))
story.append(PageBreak())

story.append(Spacer(1, 5 * mm))
story.append(Paragraph("Порядок работы и безопасность", styles["TitleRu"]))
story.append(Paragraph("Сценарий пользователя", styles["H2Ru"]))
steps = [
    "Пользователь рекламного кабинета открывает страницу Яндекс OAuth и разрешает приложению доступ к данным Директа.",
    "OAuth-токен сохраняется в локальном защищённом окружении и не передаётся сторонним сервисам.",
    "Оператор запрашивает статистику или формирует изменение через Codex Desktop.",
    "Локальный MCP-сервер обращается к API по HTTPS и возвращает структурированный результат.",
    "Для операций записи оператор сначала получает полный предпросмотр, затем отдельно подтверждает применение.",
    "Результат повторно считывается из API и фиксируется в журнале операций.",
]
for i, text in enumerate(steps, 1):
    story.append(
        KeepTogether(
            [
                Table(
                    [[Paragraph(str(i), styles["TagRu"]), Paragraph(text, styles["BodyRu"])]],
                    colWidths=[8 * mm, 162 * mm],
                    style=TableStyle(
                        [
                            ("BACKGROUND", (0, 0), (0, 0), RED),
                            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                            ("LEFTPADDING", (0, 0), (0, 0), 0),
                            ("RIGHTPADDING", (0, 0), (0, 0), 0),
                            ("TOPPADDING", (0, 0), (0, 0), 2.2 * mm),
                            ("BOTTOMPADDING", (0, 0), (0, 0), 2.2 * mm),
                            ("LEFTPADDING", (1, 0), (1, 0), 3 * mm),
                            ("TOPPADDING", (1, 0), (1, 0), 1.7 * mm),
                            ("BOTTOMPADDING", (1, 0), (1, 0), 1.7 * mm),
                        ]
                    ),
                ),
                Spacer(1, 1.2 * mm),
            ]
        )
    )

story.append(Paragraph("Проект интерфейса", styles["H2Ru"]))
story.append(MockPanel(PAGE_W - 2 * MARGIN_X))
story.append(Paragraph("Ограничения", styles["H2Ru"]))
story.extend(
    [
        bullet("Приложение не проводит платежи и не получает платёжные реквизиты пользователей."),
        bullet("Приложение не публикует изменения и не включает расход бюджета без явного подтверждения оператора."),
        bullet("Доступ ограничен правами пользователя, выдавшего OAuth-разрешение."),
        bullet("Внешнего публичного интерфейса нет: приложение предназначено для внутреннего использования MENTORI."),
    ]
)
story.append(
    Paragraph(
        "Демонстрация: поскольку приложение работает локально, публичный демо-доступ отсутствует. По запросу может быть предоставлена видеодемонстрация либо показ экрана в согласованное время.",
        styles["SmallRu"],
    )
)

doc.build(story)
print(OUTPUT)
