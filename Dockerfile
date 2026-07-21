FROM python:3.9-slim-bullseye
COPY . /opt/holehe
WORKDIR /opt/holehe
RUN pip install requests
RUN pip install .